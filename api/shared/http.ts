import { createHash, timingSafeEqual } from 'node:crypto';
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
    'Access-Control-Allow-Headers': 'Content-Type, x-slowmate-secret, x-slowmate-admin',
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

export type AdminStatus = 'none' | 'valid' | 'invalid';

/**
 * 管理員通道：Header `x-slowmate-admin` 必須等於 App Setting `ADMIN_TOKEN`。
 * Email 不再具有任何特權（舊版以 Email 白名單判斷，任何人輸入該 Email 即可無限免費使用）。
 * - 沒帶 header → 'none'（一般使用者流程）
 * - 帶了但不符，或伺服器未設定足夠長度（>= 32 字元）的 ADMIN_TOKEN → 'invalid'（fail closed）
 */
export function adminStatus(request: HttpRequest): AdminStatus {
  const provided = (request.headers.get('x-slowmate-admin') || '').trim();
  if (!provided) return 'none';
  const expected = (process.env.ADMIN_TOKEN || '').trim();
  if (expected.length < 32) return 'invalid';
  // 先雜湊成等長摘要再比對，避免長度差異造成的時序側通道
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
