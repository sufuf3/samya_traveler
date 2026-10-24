import { randomInt, timingSafeEqual } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { BadRequestError, json, normalizeEmail, readJsonBody } from '../shared/http';
import { escapeHtml, sendMail } from '../shared/mailer';
import { CODE_PK, TABLES, getTable, statusOf } from '../shared/storage';

/**
 * POST /api/generate-code
 *
 * 給 Azure Logic App 使用：收到 Portaly 贊助通知信後呼叫，產生一組 SLOW-XXXX-YYYY
 * 一次性序號寫入 RedeemCodes（is_used = false）。
 *
 * 認證（擇一符合即放行）：
 *   - Query  ?code=<金鑰>  或 Header x-functions-key: <金鑰>（Azure Function Key 慣用寫法）
 *   - Header x-slowmate-secret: <金鑰>
 *   金鑰需等於 App Setting 的 GENERATE_CODE_SECRET 或 GENERATE_CODE_FUNCTION_KEY。
 *   兩個設定都沒填時一律拒絕（fail closed）。
 *   註：程式碼讀不到 Azure 平台自動產生的 Function Key，若要沿用它，請把該值複製到 GENERATE_CODE_FUNCTION_KEY。
 *
 * Body（皆為選填）：
 * {
 *   "sponsor_email": "fan@example.com",
 *   "sponsor_name": "小明",
 *   "amount": 150,
 *   "currency": "TWD",
 *   "order_id": "PT-123456",   // 也接受 portaly_order_id。唯一冪等鍵：只有同一個 order_id 才回傳同一組序號
 *   "notify": true
 * }
 *
 * 重複贊助：同一位贊助者（同 Email）贊助第 2、3 次時，只要 order_id 不同或未提供，每次都會產生全新序號。
 *
 * 發信權責：
 *   - 有 RESEND_API_KEY、有 sponsor_email、且 notify !== false → 由本 Function 直接寄出序號信（delivery: 'function'）
 *   - 否則只回傳序號 JSON，由 Logic App 自行寄出（delivery: 'logic_app'）
 *
 * 回應：201 { code, created_at, email_sent, delivery }，order_id 重送時 200 { code, idempotent: true, ... }
 */

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

interface RedeemCodeEntity {
  partitionKey: string;
  rowKey: string;
  code: string;
  is_used: boolean;
  created_at: string;
  source: string;
  sponsor_email: string;
  sponsor_name: string;
  amount: number;
  currency: string;
  portaly_order_id: string;
  email_sent: boolean;
}

function renderCodeEmail(code: string, sponsorName: string): { html: string; text: string } {
  const name = sponsorName ? `${sponsorName}，` : '';
  const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FBF9F5;font-family:'Noto Sans TC',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF9F5;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E6E1D6;border-radius:20px;">
        <tr><td style="padding:28px 24px;color:#2C3531;">
          <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:14px;letter-spacing:2px;color:#435E4F;font-weight:700;">SlowMate · AI Travel Planner</div>
          <h1 style="font-family:'Noto Serif TC',Georgia,serif;font-size:21px;margin:12px 0;">☕ ${escapeHtml(name)}謝謝你的隨喜贊助！</h1>
          <p style="font-size:14px;line-height:1.8;color:#6E7873;margin:0 0 18px;">你的支持讓 SlowMate 能繼續陪伴更多旅人慢慢走。以下是你的專屬<strong>一次性解鎖序號</strong>：</p>
          <div style="text-align:center;background:#E6EFEA;border:1px dashed #5B7B6A;border-radius:14px;padding:18px 10px;font-family:'SFMono-Regular',Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:3px;color:#435E4F;">${escapeHtml(code)}</div>
          <p style="font-size:13px;line-height:1.8;color:#6E7873;margin:18px 0;">
            • 一組序號可完整生成 1 次慢旅行程。<br>
            • 只有在行程「成功生成」後才會核銷；若遇到當日名額已滿或生成失敗，序號會完整保留。
          </p>
          <div style="text-align:center;margin:22px 0 6px;">
            <a href="https://samya-traveler.github.io/slowmate/" style="display:inline-block;background:#5B7B6A;color:#FFFFFF;text-decoration:none;font-weight:700;border-radius:12px;padding:12px 26px;font-size:15px;">✨ 立即前往 SlowMate 規劃旅程</a>
          </div>
        </td></tr>
      </table>
      <div style="font-size:12px;color:#6E7873;margin-top:14px;">Curated Slow Travel by @samya_traveler</div>
    </td></tr>
  </table>
</body></html>`;
  const text = `${name}謝謝你的隨喜贊助！

你的 SlowMate 一次性解鎖序號：${code}

• 一組序號可完整生成 1 次慢旅行程。
• 只有在行程成功生成後才會核銷；若遇到當日名額已滿或生成失敗，序號會完整保留。

立即前往：https://samya-traveler.github.io/slowmate/
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
    const amount = Number(body.amount);
    const currency = String(body.currency ?? '').trim().toUpperCase().slice(0, 8);
    const orderId = String(body.order_id ?? body.portaly_order_id ?? '').trim().slice(0, 120);
    const notify = body.notify !== false && body.notify !== 'false';

    const table = await getTable(TABLES.RedeemCodes);

    // 冪等：只有「同一個 order_id」才回傳同一組序號；同一位贊助者的新贊助（不同或沒有 order_id）一律發新序號
    if (orderId) {
      const existing = table.listEntities<RedeemCodeEntity>({
        queryOptions: { filter: odata`PartitionKey eq ${CODE_PK} and portaly_order_id eq ${orderId}` }
      });
      for await (const e of existing) {
        return json(request, 200, {
          code: e.rowKey,
          created_at: e.created_at,
          is_used: e.is_used === true,
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
          created_at: createdAt,
          source: 'portaly',
          sponsor_email: sponsorEmail,
          sponsor_name: sponsorName,
          amount: Number.isFinite(amount) ? amount : 0,
          currency,
          portaly_order_id: orderId,
          email_sent: false
        });
        code = candidate;
      } catch (err) {
        if (statusOf(err) === 409) continue; // 極小機率撞號，重抽
        throw err;
      }
    }
    if (!code) throw new Error('序號連續碰撞，無法產生');

    // 發信權責：有 Resend 金鑰且未指定 notify:false → Function 寄；否則交給 Logic App
    const functionSends = !!sponsorEmail && notify && !!process.env.RESEND_API_KEY;
    let emailSent = false;
    let emailError: string | undefined;
    if (functionSends) {
      try {
        const { html, text } = renderCodeEmail(code, sponsorName);
        await sendMail({ to: sponsorEmail, subject: '☕ 謝謝你的贊助！這是你的 SlowMate 一次性解鎖序號', html, text });
        emailSent = true;
        await table.updateEntity({ partitionKey: CODE_PK, rowKey: code, email_sent: true }, 'Merge');
      } catch (err) {
        emailError = (err as Error)?.message ?? String(err);
        context.error('[generateCode] 序號信寄送失敗（序號已建立，請由 Logic App 補寄）', err);
      }
    }
    const delivery = emailSent ? 'function' : 'logic_app';

    context.log(`[generateCode] created code=${code} order=${orderId || '-'} delivery=${delivery}`);
    return json(request, 201, {
      code,
      created_at: createdAt,
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

app.http('generateCode', {
  route: 'generate-code',
  methods: ['POST'],
  // 改為 anonymous 並在程式內驗證，才能讓「Function Key 或 x-slowmate-secret 擇一」都可通過
  authLevel: 'anonymous',
  handler: generateCode
});
