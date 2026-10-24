import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { escapeHtml } from './mailer';
import { OTP_PK, TABLES, emailRowKey, getEntityOrNull, getTable, statusOf, taipeiDateKey } from './storage';

/**
 * 首次免費額度的 Email 6 位數驗證碼（OTP）。
 *
 * EmailOtps 表欄位：
 *   otp_hash       sha256(email:code:pepper)，不存明碼
 *   expires_at     寄出後 10 分鐘
 *   attempt_count  輸入錯誤次數，達 5 次即鎖定（需重新寄送）
 *   last_sent_at   60 秒寄送冷卻
 *   send_day / send_count  同一信箱每日最多寄送次數（OTP_MAX_SENDS_PER_DAY，預設 5）
 *
 * 驗證成功後不會立刻作廢：只有行程「成功生成」才 consumeOtp，
 * 因此 AI 生成失敗時，使用者可在 10 分鐘內用同一組驗證碼直接重試。
 */

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

interface OtpEntity {
  email?: string;
  otp_hash?: string;
  expires_at?: string;
  attempt_count?: number;
  last_sent_at?: string;
  send_day?: string;
  send_count?: number;
  consumed_at?: string;
}

function pepper(): string {
  return process.env.OTP_SECRET || process.env.GENERATE_CODE_SECRET || 'slowmate-otp';
}

function hashOtp(email: string, code: string): string {
  return createHash('sha256').update(`${email}:${code}:${pepper()}`).digest('hex');
}

function maxSendsPerDay(): number {
  const n = Number.parseInt(process.env.OTP_MAX_SENDS_PER_DAY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export function normalizeOtpInput(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '');
}

export type IssueResult =
  | { status: 'ok'; code: string; previous: OtpEntity | null }
  | { status: 'cooldown'; retryAfter: number }
  | { status: 'daily_limit' };

/** 產生新驗證碼並寫入（舊碼立即失效、錯誤次數歸零）。寄信由呼叫端負責。 */
export async function issueOtp(email: string): Promise<IssueResult> {
  const table = await getTable(TABLES.EmailOtps);
  const rk = emailRowKey(email);

  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await getEntityOrNull<OtpEntity>(table, OTP_PK, rk);
    const now = Date.now();

    if (cur?.last_sent_at) {
      const elapsed = now - Date.parse(cur.last_sent_at);
      if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        return { status: 'cooldown', retryAfter: Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000) };
      }
    }

    const today = taipeiDateKey();
    const sentToday = cur?.send_day === today ? Number(cur.send_count) || 0 : 0;
    if (sentToday >= maxSendsPerDay()) return { status: 'daily_limit' };

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const fields = {
      partitionKey: OTP_PK,
      rowKey: rk,
      email,
      otp_hash: hashOtp(email, code),
      expires_at: new Date(now + OTP_TTL_MS).toISOString(),
      attempt_count: 0,
      last_sent_at: new Date(now).toISOString(),
      send_day: today,
      send_count: sentToday + 1,
      consumed_at: ''
    };

    try {
      if (cur) {
        await table.updateEntity(fields, 'Merge', { etag: cur.etag });
      } else {
        await table.createEntity(fields);
      }
      return { status: 'ok', code, previous: cur };
    } catch (err) {
      const s = statusOf(err);
      if (s === 412 || s === 409) continue; // 併發寄送：重新讀取，通常會落入冷卻
      throw err;
    }
  }
  return { status: 'cooldown', retryAfter: Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000) };
}

/** 寄信失敗時回復到寄送前的狀態，讓使用者不必等待冷卻即可重試。 */
export async function rollbackIssuedOtp(email: string, previous: OtpEntity | null): Promise<void> {
  const table = await getTable(TABLES.EmailOtps);
  const rk = emailRowKey(email);
  if (!previous) {
    await table.deleteEntity(OTP_PK, rk).catch(() => undefined);
    return;
  }
  await table
    .updateEntity(
      {
        partitionKey: OTP_PK,
        rowKey: rk,
        otp_hash: previous.otp_hash ?? '',
        expires_at: previous.expires_at ?? '',
        attempt_count: previous.attempt_count ?? 0,
        last_sent_at: previous.last_sent_at ?? '',
        send_day: previous.send_day ?? '',
        send_count: previous.send_count ?? 0
      },
      'Merge'
    )
    .catch(() => undefined);
}

export type VerifyResult =
  | { status: 'ok' }
  | { status: 'invalid'; attemptsLeft: number }
  | { status: 'expired' | 'locked' | 'missing' };

/** 核對驗證碼。輸錯會累計次數（ETag 防併發灌爆），成功不作廢。 */
export async function verifyOtp(email: string, code: string): Promise<VerifyResult> {
  if (!/^\d{6}$/.test(code)) return { status: 'invalid', attemptsLeft: OTP_MAX_ATTEMPTS };
  const table = await getTable(TABLES.EmailOtps);
  const rk = emailRowKey(email);

  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await getEntityOrNull<OtpEntity>(table, OTP_PK, rk);
    if (!cur || !cur.otp_hash) return { status: 'missing' };
    if (!cur.expires_at || Date.parse(cur.expires_at) <= Date.now()) return { status: 'expired' };
    const attempts = Number(cur.attempt_count) || 0;
    if (attempts >= OTP_MAX_ATTEMPTS) return { status: 'locked' };

    const expected = Buffer.from(cur.otp_hash, 'hex');
    const actual = Buffer.from(hashOtp(email, code), 'hex');
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return { status: 'ok' };
    }

    try {
      await table.updateEntity({ partitionKey: OTP_PK, rowKey: rk, attempt_count: attempts + 1 }, 'Merge', {
        etag: cur.etag
      });
      return { status: 'invalid', attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts - 1) };
    } catch (err) {
      if (statusOf(err) === 412) continue;
      throw err;
    }
  }
  return { status: 'locked' };
}

/** 行程成功生成後作廢驗證碼（保留冷卻與每日次數紀錄）。 */
export async function consumeOtp(email: string): Promise<void> {
  const table = await getTable(TABLES.EmailOtps);
  await table.updateEntity(
    { partitionKey: OTP_PK, rowKey: emailRowKey(email), otp_hash: '', expires_at: '', consumed_at: new Date().toISOString() },
    'Merge'
  );
}

export function renderOtpEmail(code: string): { subject: string; html: string; text: string } {
  const subject = `您的 SlowMate 慢旅規劃驗證碼：${code}`;
  const text = `您的 SlowMate 慢旅規劃驗證碼為：【${code}】，10 分鐘內有效。

若這不是您本人的操作，請直接忽略此信。
— SlowMate AI Travel Planner · https://samya-traveler.github.io/slowmate/`;
  const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FBF9F5;font-family:'Noto Sans TC',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF9F5;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E6E1D6;border-radius:20px;">
        <tr><td style="padding:28px 24px;color:#2C3531;">
          <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:14px;letter-spacing:2px;color:#435E4F;font-weight:700;">SlowMate · AI Travel Planner</div>
          <h1 style="font-family:'Noto Serif TC',Georgia,serif;font-size:20px;margin:12px 0;">📩 驗證您的電子信箱</h1>
          <p style="font-size:14px;line-height:1.8;color:#6E7873;margin:0 0 18px;">您的 SlowMate 慢旅規劃驗證碼為：</p>
          <div style="text-align:center;background:#E6EFEA;border:1px dashed #5B7B6A;border-radius:14px;padding:18px 10px;font-family:'SFMono-Regular',Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:#435E4F;">${escapeHtml(code)}</div>
          <p style="font-size:13px;line-height:1.8;color:#6E7873;margin:18px 0 0;">驗證碼 <strong>10 分鐘內有效</strong>。回到 SlowMate 頁面輸入後，就能開啟你的首次免費慢旅規劃 🌿<br>若這不是您本人的操作，請直接忽略此信。</p>
        </td></tr>
      </table>
      <div style="font-size:12px;color:#6E7873;margin-top:14px;">Curated Slow Travel by @samya_traveler</div>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html, text };
}
