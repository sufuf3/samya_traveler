import { randomInt, timingSafeEqual } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { BadRequestError, json, normalizeEmail, readJsonBody } from '../shared/http';
import { escapeHtml, isMailerConfigured, sendMail } from '../shared/mailer';
import { RedeemCodeEntity } from '../shared/redeemCodes';
import { CODE_PK, TABLES, getTable, statusOf } from '../shared/storage';

/**
 * POST /api/generateCode（舊路徑 /api/generate-code 仍可使用）
 *
 * 給 Azure Logic App 使用：監聽 Portaly 訂單完成通知信後呼叫，產生一組 SLOW-XXXX-YYYY
 * 一次性序號寫入 RedeemCodes（PartitionKey "Code"，is_used = false、status = "unused"）。
 *
 * 隨喜三階支持 NT$ 88（輕量解鎖）/ 150（標準支持）/ 300（深度熱情）：
 * 權益完全一致，一次贊助 = 一組一次性序號，成功生成一次行程後即失效。
 * 認碼不認信箱：序號不綁定 sponsor_email，可轉贈旅伴或跨信箱使用。
 * amount 只做紀錄；非三階金額（例如 Portaly 調價）仍照常發碼，僅記錄警告。
 *
 * 認證（擇一符合即放行）：
 *   - Query ?code=<金鑰> 或 Header x-functions-key: <金鑰>（Azure Function Key 慣用寫法）
 *   - Header x-slowmate-secret: <金鑰>
 *   金鑰需等於 App Setting 的 GENERATE_CODE_SECRET 或 GENERATE_CODE_FUNCTION_KEY；兩者都沒設定時一律拒絕。
 *   程式讀不到 Azure 平台自動產生的 Function Key，要沿用它請把值複製到 GENERATE_CODE_FUNCTION_KEY。
 *
 * Request Body（皆為選填）：
 * {
 *   "sponsor_email": "user@example.com",
 *   "sponsor_name": "小明",
 *   "amount": 150,                          // 也接受 "150"、"NT$ 150"
 *   "order_id": "PORTALY-20261024-XXXX",    // 也接受 portaly_order_id
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
 *   201 { code, magic_link, created_at, amount, tier?, email_sent, delivery, order_id? }
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

// 排除易混淆字元 0/O、1/I/L
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomBlock(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateRedeemCode(): string {
  return `SLOW-${randomBlock(4)}-${randomBlock(4)}`;
}

/** 一鍵帶入序號的 Magic Link（前端讀取 ?code= 後自動填入並清除網址參數） */
export function magicLink(code: string): string {
  const base = (process.env.SLOWMATE_APP_URL || 'https://samya-traveler.github.io/slowmate/').replace(/\/?$/, '/');
  return `${base}?code=${encodeURIComponent(code)}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Function Key（?code= / x-functions-key）或 x-slowmate-secret 擇一符合即可。 */
function isAuthorized(request: HttpRequest): boolean {
  const accepted = [process.env.GENERATE_CODE_SECRET, process.env.GENERATE_CODE_FUNCTION_KEY]
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
}

function renderCodeEmail(code: string, sponsorName: string): { html: string; text: string } {
  const name = sponsorName ? `${sponsorName}，` : '';
  const link = magicLink(code);
  const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FBF9F5;font-family:'Noto Sans TC',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF9F5;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E6E1D6;border-radius:20px;">
        <tr><td style="padding:28px 24px;color:#2C3531;">
          <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:14px;letter-spacing:2px;color:#435E4F;font-weight:700;">SlowMate 慢旅伴 · AI 慢旅行程規劃師</div>
          <h1 style="font-family:'Noto Serif TC',Georgia,serif;font-size:21px;margin:12px 0;">☕ ${escapeHtml(name)}謝謝你的隨喜贊助！</h1>
          <p style="font-size:14px;line-height:1.8;color:#6E7873;margin:0 0 18px;">你的支持讓 SlowMate 慢旅伴能繼續陪伴更多旅人慢慢走。以下是你的專屬<strong>一次性解鎖序號</strong>：</p>
          <div style="text-align:center;background:#E6EFEA;border:1px dashed #5B7B6A;border-radius:14px;padding:18px 10px;font-family:'SFMono-Regular',Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:3px;color:#435E4F;">${escapeHtml(code)}</div>
          <div style="text-align:center;margin:22px 0 6px;">
            <a href="${escapeHtml(link)}" style="display:inline-block;background:#5B7B6A;color:#FFFFFF;text-decoration:none;font-weight:700;border-radius:12px;padding:12px 26px;font-size:15px;">✨ 一鍵帶入序號，回到 SlowMate 規劃旅程</a>
          </div>
          <p style="font-size:12px;line-height:1.7;color:#8A938E;text-align:center;margin:6px 0 18px;">點擊按鈕會自動填入序號，並恢復你贊助前填寫的表單內容。</p>
          <p style="font-size:13px;line-height:1.8;color:#6E7873;margin:0;">
            • 一組序號可完整生成 1 次慢旅行程，<strong>不限信箱</strong>，也可以轉贈給旅伴使用。<br>
            • 只有在行程「成功生成」後才會核銷；若遇到當日名額已滿或生成失敗，序號會完整保留。
          </p>
        </td></tr>
      </table>
      <div style="font-size:12px;color:#6E7873;margin-top:14px;">有任何問題歡迎私訊 IG @samya_traveler · Curated Slow Travel</div>
    </td></tr>
  </table>
</body></html>`;
  const text = `${name}謝謝你的隨喜贊助！

你的 SlowMate 慢旅伴一次性解鎖序號：${code}

一鍵帶入序號：${link}

• 一組序號可完整生成 1 次慢旅行程，不限信箱，也可以轉贈給旅伴使用。
• 只有在行程成功生成後才會核銷；若遇到當日名額已滿或生成失敗，序號會完整保留。

有任何問題歡迎私訊 IG @samya_traveler
— Curated Slow Travel by @samya_traveler`;
  return { html, text };
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
          is_used: e.is_used === true,
          status: e.status,
          email_sent: e.email_sent === true,
          order_id: orderId,
          idempotent: true
        });
      }
    }

    const createdAt = new Date().toISOString();
    let code = '';
    for (let attempt = 0; attempt < 8 && !code; attempt++) {
      const candidate = generateRedeemCode();
      try {
        await table.createEntity<RedeemCodeEntity>({
          partitionKey: CODE_PK,
          rowKey: candidate,
          code: candidate,
          is_used: false,
          status: 'unused',
          locked_at: '',
          sponsor_email: sponsorEmail,
          sponsor_name: sponsorName,
          amount,
          tier,
          currency,
          order_id: orderId,
          source: 'portaly',
          email_sent: false,
          created_at: createdAt,
          used_at: ''
        });
        code = candidate;
      } catch (err) {
        if (statusOf(err) === 409) continue; // 極小機率撞號，重抽
        throw err;
      }
    }
    if (!code) throw new Error('序號連續碰撞，無法產生');

    // 發信權責：已設定 Gmail 應用程式密碼、有收件人且未指定 notify:false → Function 寄；否則交給 Logic App
    const functionSends = !!sponsorEmail && notify && isMailerConfigured();
    let emailSent = false;
    let emailError: string | undefined;
    if (functionSends) {
      try {
        const { html, text } = renderCodeEmail(code, sponsorName);
        await sendMail({ to: sponsorEmail, subject: '☕ 謝謝你的贊助！這是你的 SlowMate 慢旅伴一次性解鎖序號', html, text });
        emailSent = true;
        await table.updateEntity({ partitionKey: CODE_PK, rowKey: code, email_sent: true }, 'Merge');
      } catch (err) {
        emailError = (err as Error)?.message ?? String(err);
        context.error('[generateCode] 序號信寄送失敗（序號已建立，請由 Logic App 補寄）', err);
      }
    }
    const delivery = emailSent ? 'function' : 'logic_app';

    context.log(`[generateCode] created code=${code} amount=${amount} order=${orderId || '-'} delivery=${delivery}`);
    return json(request, 201, {
      code,
      magic_link: magicLink(code),
      created_at: createdAt,
      amount,
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
