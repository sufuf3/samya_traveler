import { timingSafeEqual } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { BadRequestError, adminSecret, adminStatus, json, normalizeEmail, readJsonBody } from '../shared/http';
import { isMailerConfigured, renderCodeEmail, sendMail } from '../shared/mailer';
import { planForAmount, promoMode } from '../shared/plans';
import {
  AdminCodeInputError,
  AdminGenerateInput,
  adminGenerateCodes,
  createRandomCode,
  findCodeByOrderId,
  magicLink,
  viewOf
} from '../shared/redeemCodes';
import { CODE_PK, TABLES, getTable } from '../shared/storage';

/**
 * POST /api/generateCode（舊路徑 /api/generate-code 仍可使用）
 *
 * ── 模式 A：Portaly 贊助自動發碼（Google Apps Script / Logic App 呼叫）───────────────
 *   Body：{ email（或 sponsor_email）, amount, order_id?, sponsor_name?, notify? }
 *   依金額與 App Setting PROMO_MODE（NORMAL / XMAS）決定方案（見 shared/plans.ts）：
 *     NORMAL：>= 488 SM10-（10 次）、>= 300 SM5-（5 次）、其他 SM1-（1 次）
 *     XMAS  ：>= 488 XMAS14-（14 次）、>= 300 XMAS7-（7 次）、>= 199 XMAS3-（3 次）、其他 SM1-（1 次）
 *   寫入 RedeemCodes 後以 Gmail 寄出序號信（方案名稱、總次數、共享規則、一鍵帶入連結 ?code=…&email=…）。
 *   認證（擇一）：?code= / x-functions-key / x-slowmate-secret 等於 GENERATE_CODE_SECRET、GENERATE_CODE_FUNCTION_KEY 或 ADMIN_SECRET。
 *   冪等：相同且非空的 order_id 只會發一組序號。
 *
 * ── 模式 B：戰情室產碼（Header x-admin-secret = ADMIN_SECRET，且 mode 為 "batch" / "custom"）──
 *   不寄信、OwnerEmail 為空，回傳序號清單與 Magic Link（?code=…）：
 *     batch ：{ mode, prefix: "GIFT10-", count: 20, max_uses: 10, allow_same_email: true, campaign_tag: "REELS_BIRTH" }
 *     custom：{ mode, custom_code: "NOV-VIP", max_uses: 50, allow_same_email: false, campaign_tag: "NOV_GIFT" }（已存在則更新）
 *
 * 回應：
 *   201 模式 A { code, magic_link, plan_name, total_uses, allow_same_email, campaign_tag, amount, email_sent, delivery, order_id? }
 *   200 模式 A 相同 order_id 重送 { code, magic_link, idempotent: true, ... }
 *   201 模式 B { mode, codes: [{ code, magic_link, max_uses, remaining_uses, allow_same_email, campaign_tag, updated? }] }
 *   400 參數錯誤 / 401 未通過認證
 */

/** 接受 300、"300"、"NT$ 300"、"NT$1,500" 等格式，無法解析時回傳 0。 */
function parseAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const digits = String(value ?? '').replace(/[^\d.]/g, '');
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Function Key（?code= / x-functions-key）或 x-slowmate-secret 擇一符合即可。 */
function isAuthorized(request: HttpRequest): boolean {
  const accepted = [process.env.GENERATE_CODE_SECRET, process.env.GENERATE_CODE_FUNCTION_KEY, adminSecret()]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  if (accepted.length === 0) return false;

  const provided = [
    request.query.get('code'),
    request.headers.get('x-functions-key'),
    request.headers.get('x-slowmate-secret')
  ]
    .map((v) => (v || '').trim())
    .filter(Boolean);

  return provided.some((p) => accepted.some((a) => safeEqual(p, a)));
}

interface GenerateCodeBody extends AdminGenerateInput {
  email?: unknown;
  sponsor_email?: unknown;
  sponsor_name?: unknown;
  amount?: unknown;
  currency?: unknown;
  order_id?: unknown;
  portaly_order_id?: unknown;
  notify?: unknown;
}

async function handleAdmin(request: HttpRequest, context: InvocationContext, body: GenerateCodeBody): Promise<HttpResponseInit> {
  if (adminStatus(request) !== 'valid') {
    return json(request, 401, { error: 'unauthorized', message: '戰情室產碼需要管理員金鑰（x-admin-secret）。' });
  }
  const result = await adminGenerateCodes(body);
  context.log(`[generateCode] admin ${result.mode}: ${result.codes.length} code(s) campaign=${result.codes[0]?.campaign_tag}`);
  return json(request, 201, result);
}

async function handlePortaly(request: HttpRequest, context: InvocationContext, body: GenerateCodeBody): Promise<HttpResponseInit> {
  if (!isAuthorized(request)) {
    return json(request, 401, { error: 'unauthorized', message: 'Invalid secret.' });
  }

  const rawEmail = body.email ?? body.sponsor_email;
  const ownerEmail = rawEmail ? normalizeEmail(rawEmail) : '';
  const sponsorName = String(body.sponsor_name ?? '').trim().slice(0, 60);
  const amount = parseAmount(body.amount);
  const currency = String(body.currency ?? 'TWD').trim().toUpperCase().slice(0, 8) || 'TWD';
  const orderId = String(body.order_id ?? body.portaly_order_id ?? '').trim().slice(0, 120);
  const notify = body.notify !== false && body.notify !== 'false';
  const mode = promoMode();
  const plan = planForAmount(amount, mode);
  if (amount < 88) context.warn(`[generateCode] 贊助金額無法解析或低於 88：${amount}（仍照常發 1 次碼）`);

  // 冪等：只有「相同且非空的 order_id」才回傳同一組序號
  if (orderId) {
    const existing = await findCodeByOrderId(orderId);
    if (existing) {
      const v = viewOf(existing);
      return json(request, 200, {
        code: v.code,
        magic_link: magicLink(v.code, v.ownerEmail),
        plan_name: v.planName,
        total_uses: v.totalUses,
        remaining_uses: v.remainingUses,
        allow_same_email: v.allowSameEmail,
        campaign_tag: v.campaignTag,
        amount: v.amount,
        email_sent: (existing.EmailSent ?? (existing as { email_sent?: boolean }).email_sent) === true,
        order_id: orderId,
        idempotent: true
      });
    }
  }

  const code = await createRandomCode(plan.prefix, {
    totalUses: plan.totalUses,
    allowSameEmail: plan.allowSameEmail,
    campaignTag: plan.campaignTag,
    source: 'portaly',
    ownerEmail,
    amount,
    planName: plan.name,
    extra: { SponsorName: sponsorName, Currency: currency, OrderId: orderId, EmailSent: false }
  });
  const link = magicLink(code, ownerEmail);

  // 已設定 Gmail 應用程式密碼、有收件人且未指定 notify:false → Function 寄；否則交給 Apps Script / Logic App
  let emailSent = false;
  let emailError: string | undefined;
  if (ownerEmail && notify && isMailerConfigured()) {
    try {
      const mail = renderCodeEmail({
        code,
        magicLink: link,
        sponsorName,
        planName: plan.name,
        totalUses: plan.totalUses,
        allowSameEmail: plan.allowSameEmail,
        xmas: mode === 'XMAS'
      });
      await sendMail({ to: ownerEmail, subject: mail.subject, html: mail.html, text: mail.text });
      emailSent = true;
      const table = await getTable(TABLES.RedeemCodes);
      await table.updateEntity({ partitionKey: CODE_PK, rowKey: code, EmailSent: true }, 'Merge');
    } catch (err) {
      emailError = (err as Error)?.message ?? String(err);
      context.error('[generateCode] 序號信寄送失敗（序號已建立，請由 Apps Script 補寄）', err);
    }
  }
  const delivery = emailSent ? 'function' : 'logic_app';

  context.log(`[generateCode] created code=${code} plan=${plan.prefix} amount=${amount} mode=${mode} order=${orderId || '-'} delivery=${delivery}`);
  return json(request, 201, {
    code,
    magic_link: link,
    plan_name: plan.name,
    total_uses: plan.totalUses,
    allow_same_email: plan.allowSameEmail,
    campaign_tag: plan.campaignTag,
    promo_mode: mode,
    amount,
    email_sent: emailSent,
    delivery,
    ...(orderId ? { order_id: orderId } : {}),
    ...(emailError ? { email_error: emailError } : {})
  });
}

export async function generateCode(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await readJsonBody<GenerateCodeBody>(request, 8 * 1024).catch((err) => {
      // Logic App 可能不帶 body，視為空物件
      if (err instanceof BadRequestError && err.message.includes('不可為空')) return {} as GenerateCodeBody;
      throw err;
    });
    if (body.mode === 'batch' || body.mode === 'custom') return await handleAdmin(request, context, body);
    return await handlePortaly(request, context, body);
  } catch (err) {
    if (err instanceof BadRequestError || err instanceof AdminCodeInputError) {
      return json(request, 400, { error: err instanceof BadRequestError ? err.code : 'invalid_input', message: err.message });
    }
    context.error('[generateCode] 未預期錯誤', err);
    return json(request, 500, { error: 'internal_error', message: '序號產生失敗' });
  }
}

// authLevel 為 anonymous，由程式內驗證，才能做到「Function Key / x-slowmate-secret / 管理員金鑰」擇一
app.http('generateCode', {
  route: 'generateCode',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: generateCode
});

// 舊路徑相容（先前文件與 Logic App 範例使用的 /api/generate-code）
app.http('generateCodeLegacy', {
  route: 'generate-code',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: generateCode
});
