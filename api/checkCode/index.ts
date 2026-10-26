import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { BadRequestError, json, preflight, readJsonBody } from '../shared/http';
import { CODE_MESSAGES, CODE_RE, CodeView, cleanCode, cleanEmail, inspectCode } from '../shared/redeemCodes';

/**
 * POST /api/check-code   Body: { redeem_code, email? }
 *
 * 唯讀檢查序號狀態，供前端「🔑 我有贊助解鎖序號 → 驗證」按鈕與 Magic Link 帶入後使用。
 * 只查詢、不鎖定也不扣次數；真正核銷在 /api/plan 行程生成成功後才發生。
 * 帶 email 時一併檢查信箱權限（買家本人可重複使用；旅伴 / 活動公用碼每個信箱限 1 次）。
 *   200 { status: 'valid' | 'processing' | 'exhausted' | 'companion_used' | 'email_used' | 'not_found', message,
 *         remaining_uses?, total_uses?, is_owner?, allow_same_email?, plan_name? }
 *   400 { error: 'invalid_code' }   格式不符
 */

function validMessage(v: CodeView, isOwner: boolean): string {
  const left = `剩餘 ${v.remainingUses} 次`;
  if (v.allowSameEmail) return `✅ 序號有效！此序號${left}規劃額度，填好表單即可開始規劃（免收驗證碼）。`;
  if (isOwner) return `✅ 歡迎回來！你是這組序號的買家本人，可重複使用${left}額度。`;
  if (v.ownerEmail) return `✅ 旅伴分享序號有效！你的信箱可免費體驗 1 次（全組${left}）。`;
  return '✅ 活動 VIP 序號有效！每個信箱限體驗 1 次，填好表單即可開始規劃。';
}

export async function checkCode(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return preflight(request);
  try {
    const body = await readJsonBody<{ redeem_code?: unknown; email?: unknown }>(request, 1024);
    const code = cleanCode(body.redeem_code);
    if (!CODE_RE.test(code)) {
      return json(request, 400, { error: 'invalid_code', message: '序號格式不正確，請確認信件或活動貼文中的序號。' });
    }
    const email = cleanEmail(body.email).slice(0, 254);

    const check = await inspectCode(code, email);
    if (check.status === 'not_found') {
      return json(request, 200, { status: 'not_found', code, message: CODE_MESSAGES.not_found });
    }
    const v = check.view;
    const isPublic = !v.allowSameEmail && !v.ownerEmail;
    const info = {
      // 活動公用碼不透露公用池剩餘次數
      ...(isPublic ? { code_kind: 'public' } : { remaining_uses: v.remainingUses, total_uses: v.totalUses }),
      allow_same_email: v.allowSameEmail,
      is_owner: check.isOwner,
      ...(v.planName ? { plan_name: v.planName } : {})
    };
    const message = check.status === 'ok' ? validMessage(v, check.isOwner) : CODE_MESSAGES[check.status];
    return json(request, 200, { status: check.status === 'ok' ? 'valid' : check.status, code, message, ...info });
  } catch (err) {
    if (err instanceof BadRequestError) {
      return json(request, 400, { error: err.code, message: err.message });
    }
    context.error('[checkCode] 未預期錯誤', err);
    return json(request, 500, { error: 'internal_error', message: '系統忙碌中，請稍後再試。' });
  }
}

app.http('checkCode', {
  route: 'check-code',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: checkCode
});
