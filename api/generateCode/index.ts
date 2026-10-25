import { timingSafeEqual } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { BadRequestError, adminSecret, json, normalizeEmail, readJsonBody } from '../shared/http';
import { isMailerConfigured, renderCodeEmail, sendMail } from '../shared/mailer';
import { MAX_USES_LIMIT, RedeemCodeEntity, cleanCampaignTag, createRandomCode, magicLink } from '../shared/redeemCodes';
import { CODE_PK, TABLES, getTable } from '../shared/storage';

/**
 * POST /api/generateCode（舊路徑 /api/generate-code 仍可使用）
 *
 * 給 Portaly 自動發碼（Google Apps Script / Azure Logic App）使用：收到 Portaly 訂單通知後呼叫，
 * 產生一組 SLOW-XXXX-YYYY 序號寫入 RedeemCodes（campaign_tag = "PORTALY"、status = "unused"）。
 *
 * 可用次數 max_uses 依贊助金額自動設定：App Setting SPONSOR_MAX_USES（例如 "88:1,150:1,300:1"），
 * 未列出的金額為 1 次；Body 帶 max_uses 時以 Body 為準（例如活動多組福袋）。
 * 贊助序號 allow_same_email = true：同一信箱可重複使用，也可轉贈旅伴（認碼不認信箱）。
 * 非三階金額（例如 Portaly 調價）仍照常發碼，僅記錄警告。
 *
 * 認證（擇一符合即放行）：
 *   - Query ?code=<金鑰> 或 Header x-functions-key: <金鑰>（Azure Function Key 慣用寫法）
 *   - Header x-slowmate-secret: <金鑰>
 *   金鑰需等於 App Setting 的 GENERATE_CODE_SECRET、GENERATE_CODE_FUNCTION_KEY 或 ADMIN_SECRET；都沒設定時一律拒絕。
 *   程式讀不到 Azure 平台自動產生的 Function Key，要沿用它請把值複製到 GENERATE_CODE_FUNCTION_KEY。
 *
 * Request Body（皆為選填）：
 * {
 *   "sponsor_email": "user@example.com",
 *   "sponsor_name": "小明",
 *   "amount": 150,                          // 也接受 "150"、"NT$ 150"
 *   "order_id": "PORTALY-20261024-XXXX",    // 也接受 portaly_order_id
 *   "max_uses": 3,                          // 選填，覆寫依金額決定的次數
 *   "campaign_tag": "PORTALY",              // 選填
 *   "notify": true
 * }
 *
 * 冪等：只有傳入相同且非空的 order_id 才回傳同一組序號；否則每次呼叫都產生全新序號（支援同一信箱多次贊助）。
 *
 * 發信權責：
 *   - 已設定 GMAIL_APP_PASSWORD、有 sponsor_email、且 notify !== false → 由本 Function 以 Gmail 寄出序號信（delivery: 'function'），
 *     信中附一鍵帶入連結 https://samya-traveler.github.io/slowmate/?code=SLOW-XXXX-YYYY
 *   - 否則只回傳序號與 magic_link，由 Logic App 自行寄出（delivery: 'logic_app'）
 *
 * 回應：
 *   201 { code, magic_link, created_at, amount, max_uses, tier?, email_sent, delivery, order_id? }
 *   200 { code, magic_link, idempotent: true, status, ... }   相同 order_id 重送
 *   401 未通過認證
 */

const SPONSOR_TIERS: Record<number, string> = {
  88: '輕量解鎖',
  150: '標準支持',
  300: '深度熱情'
};

/** 接受 150、"150"、"NT$ 150"、"NT$1,500" 等格式，無法解析時回傳 0。 */
function parseAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const digits = String(value ?? '').replace(/[^\d.]/g, '');
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** SPONSOR_MAX_USES="88:1,150:1,300:1" → 金額對應的可用次數，未列出的金額為 1 次 */
function maxUsesForAmount(amount: number): number {
  for (const pair of (process.env.SPONSOR_MAX_USES || '').split(',')) {
    const [a, n] = pair.split(':').map((v) => Number.parseInt(v, 10));
    if (a === amount && n > 0) return Math.min(MAX_USES_LIMIT, n);
  }
  return 1;
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

interface GenerateCodeBody {
  sponsor_email?: unknown;
  sponsor_name?: unknown;
  amount?: unknown;
  currency?: unknown;
  order_id?: unknown;
  portaly_order_id?: unknown;
  notify?: unknown;
  max_uses?: unknown;
  campaign_tag?: unknown;
}

export async function generateCode(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    if (!isAuthorized(request)) {
      return json(request, 401, { error: 'unauthorized', message: 'Invalid secret.' });
    }

    const body = await readJsonBody<GenerateCodeBody>(request, 8 * 1024).catch((err) => {
      // Logic App 可能不帶 body，視為空物件
      if (err instanceof BadRequestError && err.message.includes('不可為空')) return {} as GenerateCodeBody;
      throw err;
    });

    const sponsorEmail = body.sponsor_email ? normalizeEmail(body.sponsor_email) : '';
    const sponsorName = String(body.sponsor_name ?? '').trim().slice(0, 60);
    const amount = parseAmount(body.amount);
    const tier = SPONSOR_TIERS[amount] ?? '';
    const currency = String(body.currency ?? 'TWD').trim().toUpperCase().slice(0, 8) || 'TWD';
    const orderId = String(body.order_id ?? body.portaly_order_id ?? '').trim().slice(0, 120);
    const notify = body.notify !== false && body.notify !== 'false';
    const requestedUses = Number.parseInt(String(body.max_uses ?? ''), 10);
    const maxUses = requestedUses > 0 ? Math.min(MAX_USES_LIMIT, requestedUses) : maxUsesForAmount(amount);
    const campaignTag = cleanCampaignTag(body.campaign_tag, 'PORTALY');
    if (amount && !tier) {
      context.warn(`[generateCode] 非 88/150/300 的贊助金額：${amount}（仍照常發碼）`);
    }

    const table = await getTable(TABLES.RedeemCodes);

    // 冪等：只有「相同且非空的 order_id」才回傳同一組序號；同一信箱的新贊助（不同或沒有 order_id）一律發新序號
    if (orderId) {
      const existing = table.listEntities<RedeemCodeEntity>({
        queryOptions: { filter: odata`PartitionKey eq ${CODE_PK} and order_id eq ${orderId}` }
      });
      for await (const e of existing) {
        return json(request, 200, {
          code: e.rowKey,
          magic_link: magicLink(e.rowKey as string),
          created_at: e.created_at,
          amount: e.amount,
          max_uses: Number(e.max_uses) || 1,
          is_used: e.is_used === true,
          status: e.status,
          email_sent: e.email_sent === true,
          order_id: orderId,
          idempotent: true
        });
      }
    }

    const code = await createRandomCode('SLOW', {
      maxUses,
      allowSameEmail: true,
      campaignTag,
      source: 'portaly',
      extra: { sponsor_email: sponsorEmail, sponsor_name: sponsorName, amount, tier, currency, order_id: orderId, email_sent: false }
    });
    const createdAt = new Date().toISOString();

    // 發信權責：已設定 Gmail 應用程式密碼、有收件人且未指定 notify:false → Function 寄；否則交給 Logic App
    const functionSends = !!sponsorEmail && notify && isMailerConfigured();
    let emailSent = false;
    let emailError: string | undefined;
    if (functionSends) {
      try {
        const mail = renderCodeEmail({ code, magicLink: magicLink(code), sponsorName, maxUses, allowSameEmail: true });
        await sendMail({ to: sponsorEmail, subject: mail.subject, html: mail.html, text: mail.text });
        emailSent = true;
        await table.updateEntity({ partitionKey: CODE_PK, rowKey: code, email_sent: true }, 'Merge');
      } catch (err) {
        emailError = (err as Error)?.message ?? String(err);
        context.error('[generateCode] 序號信寄送失敗（序號已建立，請由 Logic App 補寄）', err);
      }
    }
    const delivery = emailSent ? 'function' : 'logic_app';

    context.log(`[generateCode] created code=${code} amount=${amount} max_uses=${maxUses} order=${orderId || '-'} delivery=${delivery}`);
    return json(request, 201, {
      code,
      magic_link: magicLink(code),
      created_at: createdAt,
      amount,
      max_uses: maxUses,
      campaign_tag: campaignTag,
      ...(tier ? { tier } : {}),
      email_sent: emailSent,
      delivery,
      ...(orderId ? { order_id: orderId } : {}),
      ...(emailError ? { email_error: emailError } : {})
    });
  } catch (err) {
    if (err instanceof BadRequestError) {
      return json(request, 400, { error: err.code, message: err.message });
    }
    context.error('[generateCode] 未預期錯誤', err);
    return json(request, 500, { error: 'internal_error', message: '序號產生失敗' });
  }
}

// authLevel 為 anonymous，由 isAuthorized() 在程式內驗證，才能做到「Function Key 或 x-slowmate-secret 擇一」
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
