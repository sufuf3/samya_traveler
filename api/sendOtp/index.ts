import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { isDisposableEmail } from '../shared/disposable';
import { BadRequestError, envInt, isAdminEmail, json, normalizeEmail, preflight, readJsonBody } from '../shared/http';
import { sendMail } from '../shared/mailer';
import { OTP_RESEND_COOLDOWN_MS, OTP_TTL_MS, issueOtp, renderOtpEmail, rollbackIssuedOtp } from '../shared/otp';
import {
  PROFILE_PK,
  TABLES,
  decrementCounter,
  getEntityOrNull,
  getTable,
  profileRowKey,
  readCounter,
  taipeiDateKey,
  tryIncrementCounter
} from '../shared/storage';

/**
 * POST /api/send-otp   Body: { email }
 *
 * 首次免費額度的 Email 驗證碼寄送。
 *   200 { status: 'otp_sent', email, expires_in, resend_after }
 *   200 { status: 'otp_not_required' }                 管理員白名單
 *   400 { error: 'invalid_input' | 'disposable_email' } 信箱格式錯誤 / 免洗信箱
 *   402 { error: 'payment_required', portaly_url }      此信箱已用過免費額度 → 不寄信
 *   429 { error: 'otp_cooldown', retry_after }          60 秒內已寄過
 *   429 { error: 'otp_daily_limit' }                    同一信箱今日寄送次數已達上限
 *   429 { error: 'token_limit_reached' }                今日全站 50 個名額已滿（不浪費驗證信）
 *   429 { error: 'email_daily_cap' }                    今日 Resend 寄信額度已滿
 *   502 { error: 'email_failed' }                       寄信失敗（已回復冷卻，可立即重試）
 */

export async function sendOtp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return preflight(request);

  try {
    const body = await readJsonBody<{ email?: unknown }>(request, 4 * 1024);
    const email = normalizeEmail(body.email);

    if (isAdminEmail(email)) {
      return json(request, 200, { status: 'otp_not_required', email });
    }

    if (isDisposableEmail(email)) {
      return json(request, 400, {
        error: 'disposable_email',
        message: '偵測到拋棄式信箱，首次免費規劃請使用常用的真實信箱（如 Gmail、Outlook、Yahoo）。'
      });
    }

    // 已用過免費額度 → 不寄 OTP，直接引導贊助
    const profiles = await getTable(TABLES.UserProfiles);
    const profile = await getEntityOrNull<{ free_quota_used?: boolean }>(profiles, PROFILE_PK, profileRowKey(email));
    if (profile?.free_quota_used === true) {
      return json(request, 402, {
        error: 'payment_required',
        message: '此信箱的首次免費額度已使用過囉！歡迎隨喜贊助取得一次性解鎖序號。',
        portaly_url: process.env.PORTALY_URL || 'https://portaly.cc/samya_traveler'
      });
    }

    // 今日全站名額已滿就不寄驗證信，避免浪費使用者時間與寄信額度
    const limit = envInt('DAILY_GLOBAL_LIMIT', 50);
    const dateKey = taipeiDateKey();
    if ((await readCounter('plan', dateKey)) >= limit) {
      return json(request, 429, {
        error: 'token_limit_reached',
        message: '感謝熱情支持！今日 50 個慢旅名額已滿，明日請早 🌿',
        remaining_daily_quota: 0
      });
    }

    const issued = await issueOtp(email);
    if (issued.status === 'cooldown') {
      return json(request, 429, {
        error: 'otp_cooldown',
        message: `驗證碼剛剛已寄出，請 ${issued.retryAfter} 秒後再重新寄送。`,
        retry_after: issued.retryAfter,
        email
      });
    }
    if (issued.status === 'daily_limit') {
      return json(request, 429, {
        error: 'otp_daily_limit',
        message: '此信箱今日的驗證信寄送次數已達上限，請明天再試，或使用贊助序號直接生成。'
      });
    }

    // 驗證信與行程信共用 Resend 每日寄信額度
    const quota = await tryIncrementCounter('email', dateKey, envInt('EMAIL_DAILY_CAP', 95));
    if (!quota.ok) {
      await rollbackIssuedOtp(email, issued.previous);
      return json(request, 429, {
        error: 'email_daily_cap',
        message: '今日寄信服務額度已滿，請明天再試，或使用贊助序號直接生成行程。'
      });
    }

    try {
      const mail = renderOtpEmail(issued.code);
      await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (err) {
      context.error('[sendOtp] 驗證信寄送失敗', err);
      await rollbackIssuedOtp(email, issued.previous);
      await decrementCounter('email', dateKey).catch((e) => context.error('[sendOtp] 寄信額度回滾失敗', e));
      return json(request, 502, { error: 'email_failed', message: '驗證信寄送失敗，請稍後再試一次。' });
    }

    return json(request, 200, {
      status: 'otp_sent',
      message: '驗證碼已寄出',
      email,
      expires_in: OTP_TTL_MS / 1000,
      resend_after: OTP_RESEND_COOLDOWN_MS / 1000
    });
  } catch (err) {
    if (err instanceof BadRequestError) {
      return json(request, 400, { error: err.code, message: err.message });
    }
    context.error('[sendOtp] 未預期錯誤', err);
    return json(request, 500, { error: 'internal_error', message: '系統忙碌中，請稍後再試。' });
  }
}

app.http('sendOtp', {
  route: 'send-otp',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: sendOtp
});
