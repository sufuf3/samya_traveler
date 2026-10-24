import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { BadRequestError, json, preflight, readJsonBody } from '../shared/http';
import { CODE_PK, TABLES, getEntityOrNull, getTable } from '../shared/storage';

/**
 * POST /api/check-code   Body: { redeem_code }
 *
 * 唯讀檢查序號狀態，供前端「🔑 我有贊助解鎖序號 → 驗證」按鈕使用。
 * 只查詢、不核銷；真正核銷仍在 /api/plan 行程生成成功後才發生。
 *   200 { status: 'valid' | 'used' | 'not_found', message }
 *   400 { error: 'invalid_code' }   格式不符 SLOW-XXXX-YYYY
 */

const CODE_RE = /^SLOW-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export async function checkCode(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return preflight(request);
  try {
    const body = await readJsonBody<{ redeem_code?: unknown }>(request, 1024);
    const code = String(body.redeem_code ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      return json(request, 400, { error: 'invalid_code', message: '序號格式應為 SLOW-XXXX-YYYY，請再確認一次。' });
    }

    const table = await getTable(TABLES.RedeemCodes);
    const entity = await getEntityOrNull<{ is_used?: boolean }>(table, CODE_PK, code);
    if (!entity) {
      return json(request, 200, { status: 'not_found', code, message: '查無此序號，請確認信件中的序號是否輸入正確。' });
    }
    if (entity.is_used === true) {
      return json(request, 200, { status: 'used', code, message: '此序號已被使用過了，一組序號僅限生成一次。' });
    }
    return json(request, 200, { status: 'valid', code, message: '序號有效！填好表單後即可直接開始規劃（免 Email 驗證）。' });
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
