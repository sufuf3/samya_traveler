import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { BadRequestError, json, preflight, readJsonBody } from '../shared/http';
import { CODE_MESSAGES, CODE_RE, cleanCode, inspectCode } from '../shared/redeemCodes';

/**
 * POST /api/check-code   Body: { redeem_code, email? }
 *
 * 唯讀檢查序號狀態，供前端「🔑 我有贊助/活動解鎖序號 → 驗證」按鈕與 Magic Link 帶入後使用。
 * 只查詢、不鎖定也不核銷；真正核銷仍在 /api/plan 行程生成成功後才發生。
 * 帶 email 時一併檢查「每個信箱限用 1 次」的活動序號。
 *   200 { status: 'valid' | 'processing' | 'exhausted' | 'email_used' | 'not_found', message, remaining_uses?, max_uses? }
 *   400 { error: 'invalid_code' }   格式不符
 */
export async function checkCode(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return preflight(request);
  try {
    const body = await readJsonBody<{ redeem_code?: unknown; email?: unknown }>(request, 1024);
    const code = cleanCode(body.redeem_code);
    if (!CODE_RE.test(code)) {
      return json(request, 400, { error: 'invalid_code', message: '序號格式不正確，請確認信件或活動貼文中的序號。' });
    }
    const email = String(body.email ?? '').trim().toLowerCase().slice(0, 254);

    const check = await inspectCode(code, email);
    if (check.status === 'not_found') {
      return json(request, 200, { status: 'not_found', code, message: CODE_MESSAGES.not_found });
    }
    const uses = { remaining_uses: check.remainingUses, max_uses: check.maxUses };
    if (check.status === 'ok') {
      const message =
        check.maxUses > 1
          ? `序號有效！此序號尚餘 ${check.remainingUses} 次可用額度，填好表單即可開始規劃。`
          : '序號有效！填好表單即可開始規劃，成功生成行程後才會核銷。';
      return json(request, 200, { status: 'valid', code, message, ...uses });
    }
    return json(request, 200, { status: check.status, code, message: CODE_MESSAGES[check.status], ...uses });
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
