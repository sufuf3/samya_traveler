import nodemailer, { Transporter } from 'nodemailer';

/**
 * Gmail SMTP 發信（Nodemailer）。零成本、不需自訂網域。
 *
 * 環境變數：
 *   GMAIL_USER          寄件 Gmail 帳號，預設 littlebear.samya@gmail.com
 *   GMAIL_APP_PASSWORD  Google 帳戶產生的 16 碼「應用程式密碼」（自動去除空白，貼成 "abcd efgh ijkl mnop" 也沒關係）
 *   MAIL_FROM_NAME      寄件人顯示名稱，預設「SlowMate 慢旅伴」
 *   MAIL_REPLY_TO       選填，回覆信件的收件地址
 *
 * Gmail 個人帳號每日約可寄 500 封，EMAIL_DAILY_CAP 預設 400 封留緩衝。
 */

const DEFAULT_GMAIL_USER = 'littlebear.samya@gmail.com';

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
  const name = (process.env.MAIL_FROM_NAME || 'SlowMate 慢旅伴').replace(/["<>]/g, '');
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
export const SLOW_TRAVEL_NOTE_TITLE = '🌿 慢旅伴的小叮嚀：';
export const SLOW_TRAVEL_NOTE_BODY =
  '這份提案是為你梳理的旅行靈感。最迷人的風景往往藏在不期而遇的街角——實際出發時，請隨當天的天氣、體力與心情自由增減步調；造訪獨立小店或寺院前，也別忘了點擊「📍 導航」再次確認當日的營業時間與最新預約資訊喔！';
