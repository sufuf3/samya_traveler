import { createHash } from 'node:crypto';
import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { AdminStatus, adminStatus, json } from './http';
import { TABLES, getEntityOrNull, getTable, statusOf } from './storage';

/**
 * 以 IP 為單位的頻率限制（存在 Table Storage，所有 Function 執行個體共用；記憶體計數在多執行個體下會失效）。
 *
 *   AdminFail：管理員金鑰錯誤（戰情室、x-admin-secret、generateCode 的 secret）15 分鐘內 5 次 → 429，鎖 15 分鐘
 *   OtpIp    ：/api/send-otp 實際寄出驗證信，10 分鐘內最多 5 封
 *   EmailIp  ：/api/send-email 實際寄出行程信，10 分鐘內最多 5 封
 *
 * 固定視窗：第一筆紀錄的時間起算，視窗過後重新計數。IP 只存 SHA-256 雜湊，不存明碼。
 */

export const LIMITS = {
  AdminFail: { max: 5, windowMs: 15 * 60 * 1000 },
  OtpIp: { max: 5, windowMs: 10 * 60 * 1000 },
  EmailIp: { max: 5, windowMs: 10 * 60 * 1000 }
} as const;
export type LimitKind = keyof typeof LIMITS;

interface CounterEntity {
  count: number;
  windowStart: string;
}

/**
 * 請求端 IP：取 x-forwarded-for 的最後一個位址（由 Azure 前端附加，用戶端自己塞的值只會在前面），並去掉連接埠。
 */
export function clientIp(request: HttpRequest): string {
  const hops = (request.headers.get('x-forwarded-for') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let ip = hops[hops.length - 1] || request.headers.get('x-client-ip') || 'unknown';
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.split(':')[0]; // IPv4:port
  const v6 = ip.match(/^\[([^\]]+)\](?::\d+)?$/); // [IPv6]:port
  if (v6) ip = v6[1];
  return ip.toLowerCase();
}

function ipKey(request: HttpRequest): string {
  return createHash('sha256').update(clientIp(request)).digest('hex').slice(0, 40);
}

function active(e: CounterEntity | null, kind: LimitKind, now = Date.now()): { count: number; retryAfter: number } {
  if (!e) return { count: 0, retryAfter: 0 };
  const start = Date.parse(e.windowStart);
  const end = start + LIMITS[kind].windowMs;
  if (!Number.isFinite(start) || now >= end) return { count: 0, retryAfter: 0 };
  return { count: Number(e.count) || 0, retryAfter: Math.ceil((end - now) / 1000) };
}

/** 唯讀：此 IP 是否已達上限 */
export async function checkLimit(request: HttpRequest, kind: LimitKind): Promise<{ limited: boolean; retryAfter: number }> {
  const table = await getTable(TABLES.RateLimits);
  const { count, retryAfter } = active(await getEntityOrNull<CounterEntity>(table, kind, ipKey(request)), kind);
  return { limited: count >= LIMITS[kind].max, retryAfter };
}

/** 計數 +1（ETag 樂觀鎖），回傳加完後的次數與剩餘秒數 */
export async function recordHit(request: HttpRequest, kind: LimitKind): Promise<{ count: number; retryAfter: number }> {
  const table = await getTable(TABLES.RateLimits);
  const rk = ipKey(request);
  for (let attempt = 0; attempt < 6; attempt++) {
    const e = await getEntityOrNull<CounterEntity>(table, kind, rk);
    const cur = active(e, kind);
    const fresh = cur.count === 0;
    const next = { partitionKey: kind, rowKey: rk, count: cur.count + 1, windowStart: fresh ? new Date().toISOString() : e!.windowStart };
    try {
      if (e) await table.updateEntity(next, 'Replace', { etag: e.etag });
      else await table.createEntity(next);
      return { count: next.count, retryAfter: fresh ? Math.ceil(LIMITS[kind].windowMs / 1000) : cur.retryAfter };
    } catch (err) {
      if (statusOf(err) === 412 || statusOf(err) === 409) continue;
      throw err;
    }
  }
  return { count: LIMITS[kind].max, retryAfter: Math.ceil(LIMITS[kind].windowMs / 1000) };
}

/** 清除此 IP 的計數（管理員金鑰輸入正確時） */
export async function clearLimit(request: HttpRequest, kind: LimitKind): Promise<void> {
  const table = await getTable(TABLES.RateLimits);
  await table.deleteEntity(kind, ipKey(request)).catch((err) => {
    if (statusOf(err) !== 404) throw err;
  });
}

export function rateLimitedResponse(request: HttpRequest, retryAfter: number, what: string): HttpResponseInit {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return json(request, 429, {
    error: 'ip_rate_limited',
    message: `${what}的次數過多，請 ${minutes} 分鐘後再試。`,
    retry_after: retryAfter
  });
}

/* ------------------------------------------------------------------ */
/* 管理員金鑰防暴力破解                                                    */
/* ------------------------------------------------------------------ */

export type AdminAuth = AdminStatus | 'locked';

export function adminLockedResponse(request: HttpRequest, retryAfter: number): HttpResponseInit {
  return json(request, 429, {
    error: 'admin_locked',
    message: '嘗試次數過多，請 15 分鐘後再試。',
    retry_after: retryAfter
  });
}

/**
 * 記錄一次金鑰錯誤；第 5 次錯誤起回傳 locked（15 分鐘內同一 IP 一律 429，連正確金鑰也不受理）。
 */
export async function recordAdminFailure(request: HttpRequest): Promise<{ locked: boolean; retryAfter: number }> {
  const { count, retryAfter } = await recordHit(request, 'AdminFail');
  return { locked: count >= LIMITS.AdminFail.max, retryAfter };
}

/**
 * 驗證 x-admin-secret（定長雜湊 + timingSafeEqual 比對，見 http.ts），並套用 IP 鎖定：
 *   none   沒帶金鑰（一般使用者）
 *   valid  正確（清除此 IP 的錯誤計數）
 *   invalid 錯誤（累計一次）
 *   locked 此 IP 15 分鐘內已錯 5 次
 */
export async function verifyAdmin(request: HttpRequest): Promise<{ status: AdminAuth; retryAfter: number }> {
  const status = adminStatus(request);
  if (status === 'none') return { status, retryAfter: 0 };
  const lock = await checkLimit(request, 'AdminFail');
  if (lock.limited) return { status: 'locked', retryAfter: lock.retryAfter };
  if (status === 'valid') {
    await clearLimit(request, 'AdminFail');
    return { status, retryAfter: 0 };
  }
  const fail = await recordAdminFailure(request);
  return { status: fail.locked ? 'locked' : 'invalid', retryAfter: fail.retryAfter };
}
