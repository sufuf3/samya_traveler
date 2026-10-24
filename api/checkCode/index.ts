import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { BadRequestError, json, preflight, readJsonBody } from '../shared/http';
import { CODE_MESSAGES, CODE_RE, cleanCode, inspectCode } from '../shared/redeemCodes';

/**
 * POST /api/check-code   Body: { redeem_code }
 *
 * 唯讀檢查序號狀態，供前端「🔑 我有贊助解鎖序號 → 驗證」按鈕與 Magic Link 帶入後使用。
 * 只查詢、不鎖定也不核銷；真正核銷仍在 /api/plan 行程生成成功後才發生。
 *   200 { status: 'valid' | 'processing' | 'used' | 'not_found', message }
 *   400 { error: 'invalid_code' }   格式不符 SLOW-XXXX-YYYY
 */
export async function checkCode(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return preflight(request);
  try {
    const body = await readJsonBody<{ redeem_code?: unknown }>(request, 1024);
    const code = cleanCode(body.redeem_code);
    if (!CODE_RE.test(code)) {
      return json(request, 400, { error: 'invalid_code', message: '序號格式應為 SLOW-XXXX-YYYY，請再確認一次。' });
    }

    const state = await inspectCode(code);
    if (state === 'unused') {
      return json(request, 200, { status: 'valid', code, message: '序號有效！填好表單後即可直接開始規劃（免 Email 驗證）。' });
    }
    return json(request, 200, { status: state, code, message: CODE_MESSAGES[state] });
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
