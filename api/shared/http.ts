import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpRequest, HttpResponseInit } from '@azure/functions';

/**
 * CORS 與 JSON 回應工具。
 *
 * 建議在 Azure Portal「Function App → API → CORS」設定允許來源（平台層 CORS 會處理 preflight）；
 * 此處的 header 是本機 `func start` 或未設定平台 CORS 時的後備方案。
 * 注意：一旦啟用平台層 CORS，Azure 會以平台設定為準並覆寫這裡的 header。
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://samya-traveler.github.io', 'http://localhost:1313', 'http://127.0.0.1:5500'];

/** 允許的來源：App Setting ALLOWED_ORIGINS（逗號分隔），未設定時用預設清單；萬用字元 * 一律忽略 */
function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s && s !== '*');
}

function requestOrigin(request: HttpRequest): string {
  return (request.headers.get('origin') || '').replace(/\/+$/, '');
}

/**
 * 瀏覽器從不在白名單的網站呼叫時回 403，連處理都不處理（CORS 只會擋「讀取回應」，擋不住寄信等副作用）。
 * 沒有 Origin header 的請求（curl、Apps Script 等伺服器端呼叫）不受影響，仍由各端點自己的驗證把關。
 */
export function forbiddenOrigin(request: HttpRequest): HttpResponseInit | null {
  const origin = requestOrigin(request);
  if (!origin || allowedOrigins().includes(origin)) return null;
  return json(request, 403, { error: 'forbidden_origin', message: 'This origin is not allowed.' });
}

export function corsHeaders(request: HttpRequest): Record<string, string> {
  const origin = requestOrigin(request);
  const list = allowedOrigins();
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-slowmate-secret, x-slowmate-admin, x-admin-secret',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (origin && list.includes(origin)) {
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

/** 管理員金鑰：App Setting `ADMIN_SECRET`（舊名 `ADMIN_TOKEN` 仍可使用）。 */
export function adminSecret(): string {
  return (process.env.ADMIN_SECRET || process.env.ADMIN_TOKEN || '').trim();
}

/** 定長比對兩個字串（先雜湊成等長摘要，避免長度差異造成的時序側通道）。 */
export function secretEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * 管理員通道（白名單）：Header `x-admin-secret`（或舊名 `x-slowmate-admin`）必須等於 ADMIN_SECRET。
 * Email 不具有任何特權：頁面原始碼是公開的，若以 Email 判斷白名單，任何人輸入該 Email 即可無限免費使用。
 * - 沒帶 header → 'none'（一般使用者流程）
 * - 帶了但不符，或伺服器未設定足夠長度（>= 32 字元）的金鑰 → 'invalid'（fail closed）
 */
export function adminStatus(request: HttpRequest): AdminStatus {
  const provided = (request.headers.get('x-admin-secret') || request.headers.get('x-slowmate-admin') || '').trim();
  if (!provided) return 'none';
  const expected = adminSecret();
  if (expected.length < 32) return 'invalid';
  return secretEquals(provided, expected) ? 'valid' : 'invalid';
}

export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
