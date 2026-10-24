import { HttpRequest, HttpResponseInit } from '@azure/functions';

/**
 * CORS 與 JSON 回應工具。
 *
 * 建議在 Azure Portal「Function App → API → CORS」設定允許來源（平台層 CORS 會處理 preflight）；
 * 此處的 header 是本機 `func start` 或未設定平台 CORS 時的後備方案。
 * 注意：一旦啟用平台層 CORS，Azure 會以平台設定為準並覆寫這裡的 header。
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://samya-traveler.github.io'];

function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function corsHeaders(request: HttpRequest): Record<string, string> {
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  const list = allowedOrigins();
  const allowAll = list.includes('*');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-slowmate-secret',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (allowAll) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin && list.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function json(request: HttpRequest, status: number, body: unknown): HttpResponseInit {
  return {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

export function preflight(request: HttpRequest): HttpResponseInit {
  return { status: 204, headers: corsHeaders(request) };
}

export class BadRequestError extends Error {
  constructor(message: string, public readonly code = 'invalid_input') {
    super(message);
  }
}

/** 讀取 JSON body，限制大小以防濫用。 */
export async function readJsonBody<T = Record<string, unknown>>(request: HttpRequest, maxBytes: number): Promise<T> {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new BadRequestError('請求內容過大。');
  }
  if (!text.trim()) {
    throw new BadRequestError('請求內容不可為空。');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as T;
  } catch {
    throw new BadRequestError('請求內容不是有效的 JSON。');
  }
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function normalizeEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new BadRequestError('請輸入有效的電子信箱。');
  }
  return email;
}

/** 管理員白名單（不分大小寫）。預設為 sufuf3149@gmail.com，可用 ADMIN_EMAILS 以逗號分隔覆寫。 */
export function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS || 'sufuf3149@gmail.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
