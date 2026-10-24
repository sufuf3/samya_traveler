import { Resend } from 'resend';

let client: Resend | null = null;

export function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('缺少 RESEND_API_KEY 設定');
  if (!client) client = new Resend(key);
  return client;
}

export function mailFrom(): string {
  const from = process.env.RESEND_FROM;
  if (!from) throw new Error('缺少 RESEND_FROM 設定（需為 Resend 已驗證網域的寄件地址）');
  return from;
}

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** 透過 Resend 寄信，回傳 Resend 的信件 id；失敗時拋出錯誤。 */
export async function sendMail(input: SendMailInput): Promise<string> {
  const replyTo = process.env.RESEND_REPLY_TO?.trim();
  const { data, error } = await getResend().emails.send({
    from: mailFrom(),
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    ...(replyTo ? { replyTo } : {})
  });
  if (error) {
    throw new Error(`Resend 寄信失敗：${error.name ?? ''} ${error.message ?? ''}`.trim());
  }
  return data?.id ?? '';
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
