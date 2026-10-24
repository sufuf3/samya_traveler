import { randomInt, timingSafeEqual } from 'node:crypto';
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { BadRequestError, json, normalizeEmail, readJsonBody } from '../shared/http';
import { escapeHtml, sendMail } from '../shared/mailer';
import { CODE_PK, TABLES, getTable, statusOf } from '../shared/storage';

/**
 * POST /api/generate-code?code=<FUNCTION_KEY>
 * Header: x-slowmate-secret: <GENERATE_CODE_SECRET>
 *
 * 給 Azure Logic App 使用：收到 Portaly 贊助通知信後呼叫，產生一組 SLOW-XXXX-YYYY
 * 一次性序號寫入 RedeemCodes（is_used = false），並可選擇直接以 Resend 寄給贊助者。
 *
 * Body（皆為選填）：
 * {
 *   "sponsor_email": "fan@example.com",   // 有填且 notify 不為 false 時自動寄出序號信
 *   "sponsor_name": "小明",
 *   "amount": 150,
 *   "currency": "TWD",
 *   "portaly_order_id": "PT-123456",       // 冪等鍵：Logic App 重試時回傳同一組序號
 *   "notify": true
 * }
 *
 * 回應：201 { code, created_at, email_sent }，冪等命中時 200 { code, idempotent: true, ... }
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

function secretMatches(provided: string | null): boolean {
  const expected = process.env.GENERATE_CODE_SECRET;
  if (!expected) return true; // 未設定時僅依賴 Function Key 保護
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface GenerateCodeBody {
  sponsor_email?: unknown;
  sponsor_name?: unknown;
  amount?: unknown;
  currency?: unknown;
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
    if (!secretMatches(request.headers.get('x-slowmate-secret'))) {
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
    const orderId = String(body.portaly_order_id ?? '').trim().slice(0, 120);
    const notify = body.notify !== false && body.notify !== 'false';

    const table = await getTable(TABLES.RedeemCodes);

    // 冪等：同一筆 Portaly 訂單只發一組序號
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

    let emailSent = false;
    let emailError: string | undefined;
    if (sponsorEmail && notify) {
      try {
        const { html, text } = renderCodeEmail(code, sponsorName);
        await sendMail({ to: sponsorEmail, subject: '☕ 謝謝你的贊助！這是你的 SlowMate 一次性解鎖序號', html, text });
        emailSent = true;
        await table.updateEntity({ partitionKey: CODE_PK, rowKey: code, email_sent: true }, 'Merge');
      } catch (err) {
        emailError = (err as Error)?.message ?? String(err);
        context.error('[generateCode] 序號信寄送失敗（序號已建立，可由 Logic App 自行寄送）', err);
      }
    }

    context.log(`[generateCode] created code=${code} order=${orderId || '-'} email_sent=${emailSent}`);
    return json(request, 201, {
      code,
      created_at: createdAt,
      email_sent: emailSent,
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
  authLevel: 'function',
  handler: generateCode
});
