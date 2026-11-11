import nodemailer, { Transporter } from 'nodemailer';

/**
 * Gmail SMTP 發信（Nodemailer）。零成本、不需自訂網域。
 *
 * 環境變數：
 *   GMAIL_USER          寄件 Gmail 帳號，預設 littlebear.samya@gmail.com
 *   GMAIL_APP_PASSWORD  Google 帳戶產生的 16 碼「應用程式密碼」（自動去除空白，貼成 "abcd efgh ijkl mnop" 也沒關係）
 *   MAIL_FROM_NAME      寄件人顯示名稱，預設「SlowMate · AI 慢旅行程規劃助手」
 *   MAIL_REPLY_TO       選填，回覆信件的收件地址
 *
 * Gmail 個人帳號每日約可寄 500 封，EMAIL_DAILY_CAP 預設 400 封留緩衝。
 */

const DEFAULT_GMAIL_USER = 'littlebear.samya@gmail.com';

/** 品牌名稱：寄件人、信件主旨、Header 與 Footer 一律使用 */
export const BRAND_NAME = 'SlowMate · AI 慢旅行程規劃助手';

let transporter: Transporter | null = null;

export function gmailUser(): string {
  return (process.env.GMAIL_USER || DEFAULT_GMAIL_USER).trim();
}

function gmailAppPassword(): string {
  return (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
}

/** 是否已設定 Gmail 應用程式密碼（generateCode 依此決定由 Function 寄信或交給 Logic App）。 */
export function isMailerConfigured(): boolean {
  return gmailAppPassword().length > 0;
}

function getTransporter(): Transporter {
  const pass = gmailAppPassword();
  if (!pass) throw new Error('缺少 GMAIL_APP_PASSWORD 設定（Google 帳戶 → 安全性 → 應用程式密碼）');
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser(), pass },
      pool: true,
      maxConnections: 2,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000
    });
  }
  return transporter;
}

export function mailFrom(): string {
  const name = (process.env.MAIL_FROM_NAME || BRAND_NAME).replace(/["<>]/g, '');
  return `"${name}" <${gmailUser()}>`;
}

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** 透過 Gmail SMTP 寄信，回傳 Message-ID；失敗時拋出錯誤。 */
export async function sendMail(input: SendMailInput): Promise<string> {
  const replyTo = process.env.MAIL_REPLY_TO?.trim();
  try {
    const info = await getTransporter().sendMail({
      from: mailFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(replyTo ? { replyTo } : {})
    });
    return info.messageId ?? '';
  } catch (err) {
    // 帳密錯誤或連線中斷時重建連線池，下次呼叫重新登入
    transporter?.close();
    transporter = null;
    const e = err as { code?: string; responseCode?: number; message?: string };
    throw new Error(`Gmail SMTP 寄信失敗：${e.code ?? ''} ${e.responseCode ?? ''} ${e.message ?? String(err)}`.trim());
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 行程信 / 純文字行程統一使用的頁尾小叮嚀 */
export const SLOW_TRAVEL_NOTE_TITLE = '🌿 SlowMate 的小叮嚀：';
export const SLOW_TRAVEL_NOTE_BODY =
  '這份提案是為你梳理的旅行靈感。最迷人的風景往往藏在不期而遇的街角——實際出發時，請隨當天的天氣、體力與心情自由增減步調；造訪獨立小店或寺院前，也別忘了點擊「📍 導航」再次確認當日的營業時間與最新預約資訊喔！';

/* ------------------------------------------------------------------ */
/* 序號信（Portaly 贊助自動寄送：方案名稱、總次數、共享規則）                */
/* ------------------------------------------------------------------ */

export interface CodeEmailInput {
  code: string;
  magicLink: string;
  sponsorName?: string;
  /** 買家信箱：多人方案的共享規則會寫出「買家本人信箱（…）」 */
  ownerEmail?: string;
  planName: string;
  totalUses: number;
  allowSameEmail: boolean;
  /** 聖誕囤票祭：信件底部加上「曬行程抽年票」活動提示 */
  xmas?: boolean;
}

/** 共享規則說明（HTML 與純文字共用；<strong> 在純文字中會被移除） */
function codeUsageLines(totalUses: number, allowSameEmail: boolean, ownerEmail = ''): string[] {
  const lines =
    totalUses <= 1
      ? ['這組序號可完整生成 <strong>1 次</strong>慢旅行程，不限信箱，也可以轉贈給旅伴使用。']
      : allowSameEmail
        ? [`共 <strong>${totalUses} 次</strong>額度，<strong>不限本人或旅伴信箱</strong>，大家都可以自由使用，直到 ${totalUses} 次用完。`]
        : [
            `<strong>買家本人信箱${ownerEmail ? `（${escapeHtml(ownerEmail)}）` : ''}</strong>可重複使用全部 <strong>${totalUses} 次</strong>；分享給旅伴時，<strong>每位旅伴信箱限免費體驗 1 次</strong>。`,
            '可以直接把序號丟進 LINE 群組分給親友團（旅伴使用的次數同樣從總次數中扣除）。'
          ];
  lines.push('只有在行程「成功生成」後才會扣次數；若遇到當日名額已滿或生成失敗，額度會完整保留，序號也沒有使用期限。');
  return lines;
}

const XMAS_GIVEAWAY_HTML =
  '🎄 <strong>曬出你的理想行程抽年票</strong>：將排好的行程截圖分享至 IG 限動或 Threads 並標記 @samya_traveler，就有機會抽中免費【10 次額度慢旅年票】！';

export function renderCodeEmail(input: CodeEmailInput): { subject: string; html: string; text: string } {
  const total = Math.max(1, input.totalUses || 1);
  const name = input.sponsorName ? `${input.sponsorName}，` : '';
  const usage = codeUsageLines(total, input.allowSameEmail, input.ownerEmail);
  const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FBF9F5;font-family:'Noto Sans TC',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF9F5;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E6E1D6;border-radius:20px;">
        <tr><td style="padding:28px 24px;color:#2C3531;">
          <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:14px;letter-spacing:2px;color:#435E4F;font-weight:700;">${escapeHtml(BRAND_NAME)}</div>
          <h1 style="font-family:'Noto Serif TC',Georgia,serif;font-size:21px;margin:12px 0;">☕ ${escapeHtml(name)}謝謝你的隨喜贊助！</h1>
          <p style="font-size:14px;line-height:1.8;color:#6E7873;margin:0 0 16px;">你的支持讓 SlowMate 能繼續陪伴更多旅人慢慢走。以下是你的專屬解鎖序號：</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF6E9;border:1px solid #F2D7A9;border-radius:14px;margin-bottom:12px;">
            <tr><td style="padding:12px 16px;font-size:14px;line-height:1.8;color:#2C3531;">
              <div>購買方案：<strong>【${escapeHtml(input.planName)}】</strong></div>
              <div>總可用次數：<strong>${total} 次</strong></div>
            </td></tr>
          </table>
          <div style="text-align:center;background:#E6EFEA;border:1px dashed #5B7B6A;border-radius:14px;padding:18px 10px;font-family:'SFMono-Regular',Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:3px;color:#435E4F;">${escapeHtml(input.code)}</div>
          <div style="text-align:center;margin:22px 0 6px;">
            <a href="${escapeHtml(input.magicLink)}" style="display:inline-block;background:#5B7B6A;color:#FFFFFF;text-decoration:none;font-weight:700;border-radius:12px;padding:12px 26px;font-size:15px;">✨ 一鍵帶入序號，回到 SlowMate 規劃旅程</a>
          </div>
          <p style="font-size:12px;line-height:1.7;color:#8A938E;text-align:center;margin:6px 0 18px;">點擊按鈕會自動填入序號與你的 Email，並恢復你贊助前填寫的表單內容。</p>
          <p style="font-size:13px;line-height:1.8;color:#6E7873;margin:0;">${usage.map((l) => `• ${l}`).join('<br>')}</p>
          ${input.xmas ? `<div style="margin-top:18px;background:#FDECEA;border:1px solid #F3C3B4;border-radius:14px;padding:14px 16px;font-size:13px;line-height:1.8;color:#7A2E22;">${XMAS_GIVEAWAY_HTML}</div>` : ''}
        </td></tr>
      </table>
      <div style="font-size:12px;color:#6E7873;margin-top:14px;">${escapeHtml(BRAND_NAME)} · 有任何問題歡迎私訊 IG @samya_traveler</div>
    </td></tr>
  </table>
</body></html>`;
  const strip = (l: string) => l.replace(/<\/?strong>/g, '');
  const text = `${name}謝謝你的隨喜贊助！

購買方案：【${input.planName}】
總可用次數：${total} 次
你的解鎖序號：${input.code}

一鍵帶入序號：${input.magicLink}

${usage.map((l) => `• ${strip(l)}`).join('\n')}
${input.xmas ? `\n${strip(XMAS_GIVEAWAY_HTML)}\n` : ''}
有任何問題歡迎私訊 IG @samya_traveler
— ${BRAND_NAME} · https://samya-traveler.github.io/slowmate/`;
  const subject = `☕ 你的【${input.planName}】解鎖序號（${total} 次額度）｜${BRAND_NAME}`;
  return { subject, html, text };
}
