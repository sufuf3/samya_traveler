import { randomUUID } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { envInt } from './http';

/**
 * Azure Table Storage 存取層。
 *
 * - DailyUsage   : RowKey = 台灣日期 YYYY-MM-DD
 *     PartitionKey 'Daily'      ：雙水池名額 free_used（免費席，上限 50）、code_used（序號保留席，上限 30）、
 *                                 vip_whitelist_used（管理員，只統計不設限）；usedCount = free_used + code_used（舊欄位相容）
 *     PartitionKey 'EmailDaily' ：每日寄信封數 usedCount
 * - UserProfiles : PartitionKey = 'User'，RowKey = email（小寫），記錄 free_quota_used、used_at、total_trips
 * - RedeemCodes  : PartitionKey = 'RedeemCode'（舊資料 'Code'），RowKey = 序號，欄位 TotalUses / RemainingUses / OwnerEmail 等（見 redeemCodes.ts）
 * - EmailOtps    : PartitionKey = 'OTP'，RowKey = email（小寫），首次免費額度的 Email 驗證碼
 *
 * 所有「讀 → 判斷 → 寫」都使用 ETag 樂觀鎖，避免高併發時超賣名額或重複核銷序號。
 */
export const TABLES = {
  DailyUsage: 'DailyUsage',
  UserProfiles: 'UserProfiles',
  RedeemCodes: 'RedeemCodes',
  EmailOtps: 'EmailOtps',
  /** 序號 × 信箱的使用紀錄（PartitionKey = 序號、RowKey = 小寫 email），大型公用碼不受單一欄位 64 KB 限制 */
  RedeemCodeUsers: 'RedeemCodeUsers',
  /** IP 頻率限制計數（PartitionKey = 用途、RowKey = IP 雜湊），見 rateLimit.ts */
  RateLimits: 'RateLimits'
} as const;
export type TableName = (typeof TABLES)[keyof typeof TABLES];

export const PROFILE_PK = 'User';
/** RedeemCodes：新序號寫在 'RedeemCode'；2026/10 以前的序號留在舊的 'Code'，讀取時兩者都會查 */
export const CODE_PK = 'RedeemCode';
export const LEGACY_CODE_PK = 'Code';
export const OTP_PK = 'OTP';

/** DailyUsage 的 PartitionKey */
export const PLAN_COUNTER = 'Daily';
export const EMAIL_COUNTER = 'EmailDaily';

const clients = new Map<TableName, TableClient>();
const ensured = new Set<TableName>();

function connectionString(): string {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!conn) throw new Error('缺少 AZURE_STORAGE_CONNECTION_STRING（或 AzureWebJobsStorage）設定');
  return conn;
}

export async function getTable(name: TableName): Promise<TableClient> {
  let client = clients.get(name);
  if (!client) {
    const conn = connectionString();
    const isLocal = conn.includes('UseDevelopmentStorage=true') || conn.includes('127.0.0.1') || conn.includes('localhost');
    client = TableClient.fromConnectionString(conn, name, { allowInsecureConnection: isLocal });
    clients.set(name, client);
  }
  if (!ensured.has(name)) {
    // 資料表已存在時 createTable 不會拋錯
    await client.createTable();
    ensured.add(name);
  }
  return client;
}

export function statusOf(err: unknown): number | undefined {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(20 + Math.floor(Math.random() * 80));

export type Entity<T> = T & { partitionKey: string; rowKey: string; etag: string };

export async function getEntityOrNull<T extends object>(table: TableClient, pk: string, rk: string): Promise<Entity<T> | null> {
  try {
    const e = await table.getEntity<T>(pk, rk);
    return e as unknown as Entity<T>;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 台灣時間 (Asia/Taipei, UTC+8，無日光節約) 日期鍵                         */
/* ------------------------------------------------------------------ */

export function taipeiDateKey(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* DailyUsage 計數器                                                     */
/* ------------------------------------------------------------------ */

interface CounterEntity {
  usedCount: number;
  updatedAt?: string;
}

export async function readCounter(kind: string, dateKey: string): Promise<number> {
  const table = await getTable(TABLES.DailyUsage);
  const e = await getEntityOrNull<CounterEntity>(table, kind, dateKey);
  return e ? Number(e.usedCount) || 0 : 0;
}

/**
 * 嘗試在上限內 +1。成功回傳 { ok: true, used }；已滿回傳 { ok: false, used }。
 */
export async function tryIncrementCounter(kind: string, dateKey: string, limit: number): Promise<{ ok: boolean; used: number }> {
  const table = await getTable(TABLES.DailyUsage);
  for (let attempt = 0; attempt < 10; attempt++) {
    const e = await getEntityOrNull<CounterEntity>(table, kind, dateKey);
    if (!e) {
      if (limit < 1) return { ok: false, used: 0 };
      try {
        await table.createEntity<CounterEntity>({
          partitionKey: kind,
          rowKey: dateKey,
          usedCount: 1,
          updatedAt: new Date().toISOString()
        });
        return { ok: true, used: 1 };
      } catch (err) {
        if (statusOf(err) === 409) {
          await jitter();
          continue;
        }
        throw err;
      }
    }
    const used = Number(e.usedCount) || 0;
    if (used >= limit) return { ok: false, used };
    try {
      await table.updateEntity<CounterEntity>(
        { partitionKey: kind, rowKey: dateKey, usedCount: used + 1, updatedAt: new Date().toISOString() },
        'Merge',
        { etag: e.etag }
      );
      return { ok: true, used: used + 1 };
    } catch (err) {
      if (statusOf(err) === 412) {
        await jitter();
        continue;
      }
      throw err;
    }
  }
  throw new Error(`DailyUsage(${kind}/${dateKey}) 更新衝突過多，請稍後再試`);
}

/** 失敗回滾：-1（最低為 0）。回傳回滾後的使用量。 */
export async function decrementCounter(kind: string, dateKey: string): Promise<number> {
  const table = await getTable(TABLES.DailyUsage);
  for (let attempt = 0; attempt < 10; attempt++) {
    const e = await getEntityOrNull<CounterEntity>(table, kind, dateKey);
    if (!e) return 0;
    const next = Math.max(0, (Number(e.usedCount) || 0) - 1);
    try {
      await table.updateEntity<CounterEntity>(
        { partitionKey: kind, rowKey: dateKey, usedCount: next, updatedAt: new Date().toISOString() },
        'Merge',
        { etag: e.etag }
      );
      return next;
    } catch (err) {
      if (statusOf(err) === 412) {
        await jitter();
        continue;
      }
      throw err;
    }
  }
  throw new Error(`DailyUsage(${kind}/${dateKey}) 回滾衝突過多`);
}

/* ------------------------------------------------------------------ */
/* 雙水池每日名額（PartitionKey 'Daily'）                                  */
/*                                                                      */
/*   免費席 free_used ≤ 50：首次免費試用者（過 OTP）只能用這一池           */
/*   序號席 code_used ≤ 30：持序號者先用免費席，免費席滿了才動用保留席      */
/*   管理員 vip_whitelist_used：只統計、不設上限                          */
/* ------------------------------------------------------------------ */

export type PoolField = 'free_used' | 'code_used' | 'vip_whitelist_used';
export type PoolKind = 'free' | 'code' | 'whitelist';

export interface PoolUsage {
  free_used: number;
  code_used: number;
  vip_whitelist_used: number;
}

export interface PoolRemaining {
  free_remaining: number;
  vip_pool_remaining: number;
  code_total_remaining: number;
}

interface DailyPoolEntity extends Partial<PoolUsage> {
  usedCount?: number;
  updatedAt?: string;
}

export function poolLimits(): { free: number; vip: number } {
  return { free: envInt('FREE_DAILY_LIMIT', envInt('DAILY_GLOBAL_LIMIT', 50)), vip: envInt('VIP_POOL_LIMIT', 30) };
}

function usageOf(e: DailyPoolEntity | null): PoolUsage {
  if (!e) return { free_used: 0, code_used: 0, vip_whitelist_used: 0 };
  return {
    // 雙水池上線前的資料列只有 usedCount，視為免費席用量
    free_used: Number(e.free_used ?? e.usedCount) || 0,
    code_used: Number(e.code_used) || 0,
    vip_whitelist_used: Number(e.vip_whitelist_used) || 0
  };
}

export function poolRemaining(usage: PoolUsage): PoolRemaining {
  const { free, vip } = poolLimits();
  const freeRemaining = Math.max(0, free - usage.free_used);
  const vipRemaining = Math.max(0, vip - usage.code_used);
  return { free_remaining: freeRemaining, vip_pool_remaining: vipRemaining, code_total_remaining: freeRemaining + vipRemaining };
}

export async function readPoolUsage(dateKey: string): Promise<PoolUsage> {
  const table = await getTable(TABLES.DailyUsage);
  return usageOf(await getEntityOrNull<DailyPoolEntity>(table, PLAN_COUNTER, dateKey));
}

/** 依池別決定這次要扣哪個欄位；回傳 null 表示該池已滿。 */
function pickPoolField(kind: PoolKind, usage: PoolUsage): PoolField | null {
  const { free, vip } = poolLimits();
  if (kind === 'whitelist') return 'vip_whitelist_used';
  if (usage.free_used < free) return 'free_used';
  if (kind === 'code' && usage.code_used < vip) return 'code_used';
  return null;
}

async function writePool(dateKey: string, update: (usage: PoolUsage) => PoolUsage | null): Promise<{ ok: boolean; usage: PoolUsage }> {
  const table = await getTable(TABLES.DailyUsage);
  for (let attempt = 0; attempt < 10; attempt++) {
    const e = await getEntityOrNull<DailyPoolEntity>(table, PLAN_COUNTER, dateKey);
    const current = usageOf(e);
    const next = update(current);
    if (!next) return { ok: false, usage: current };
    const entity = { partitionKey: PLAN_COUNTER, rowKey: dateKey, ...next, usedCount: next.free_used + next.code_used, updatedAt: new Date().toISOString() };
    try {
      if (e) await table.updateEntity(entity, 'Merge', { etag: e.etag });
      else await table.createEntity(entity);
      return { ok: true, usage: next };
    } catch (err) {
      const status = statusOf(err);
      if (status === 412 || status === 409) {
        await jitter();
        continue;
      }
      throw err;
    }
  }
  throw new Error(`DailyUsage(${PLAN_COUNTER}/${dateKey}) 更新衝突過多，請稍後再試`);
}

/**
 * 預扣一席（ETag 樂觀鎖）。成功回傳實際扣到的欄位，供失敗時 releasePool() 精準回滾。
 *   free      ：只能扣免費席
 *   code      ：免費席還有就扣免費席，否則扣序號保留席
 *   whitelist ：管理員，只 +1 統計
 */
export async function reservePool(
  dateKey: string,
  kind: PoolKind
): Promise<{ ok: true; field: PoolField; usage: PoolUsage } | { ok: false; usage: PoolUsage }> {
  let field: PoolField | null = null;
  const result = await writePool(dateKey, (usage) => {
    field = pickPoolField(kind, usage);
    return field ? { ...usage, [field]: usage[field] + 1 } : null;
  });
  return result.ok && field ? { ok: true, field, usage: result.usage } : { ok: false, usage: result.usage };
}

/** 生成失敗：把 reservePool() 扣掉的那一席還回去（最低為 0）。 */
export async function releasePool(dateKey: string, field: PoolField): Promise<PoolUsage> {
  const result = await writePool(dateKey, (usage) => ({ ...usage, [field]: Math.max(0, usage[field] - 1) }));
  return result.usage;
}

/* ------------------------------------------------------------------ */
/* 一次性資格租約（序號 / 免費試用）                                        */
/*                                                                      */
/* is_used 只在 AI 生成成功後才變成 true；生成期間以 lease_until 暫時鎖住，   */
/* 防止同一組序號被兩個分頁同時拿去生成。失敗時釋放租約，資格完全不損耗。       */
/* ------------------------------------------------------------------ */

const LEASE_MS = 5 * 60 * 1000;

interface LeaseFields {
  lease_id?: string;
  lease_until?: string;
}

export type LeaseResult = { status: 'ok'; leaseId: string } | { status: 'not_found' | 'used' | 'busy' };

export async function acquireLease(
  tableName: TableName,
  pk: string,
  rk: string,
  usedField: string,
  createIfMissing?: Record<string, unknown>
): Promise<LeaseResult> {
  const table = await getTable(tableName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const e = await getEntityOrNull<Record<string, unknown> & LeaseFields>(table, pk, rk);
    const leaseId = randomUUID();
    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();

    if (!e) {
      if (!createIfMissing) return { status: 'not_found' };
      try {
        await table.createEntity({
          ...createIfMissing,
          partitionKey: pk,
          rowKey: rk,
          [usedField]: false,
          lease_id: leaseId,
          lease_until: leaseUntil
        });
        return { status: 'ok', leaseId };
      } catch (err) {
        if (statusOf(err) === 409) continue;
        throw err;
      }
    }

    if (e[usedField] === true) return { status: 'used' };
    if (e.lease_until && Date.parse(e.lease_until) > Date.now()) return { status: 'busy' };

    try {
      await table.updateEntity({ partitionKey: pk, rowKey: rk, lease_id: leaseId, lease_until: leaseUntil }, 'Merge', {
        etag: e.etag
      });
      return { status: 'ok', leaseId };
    } catch (err) {
      if (statusOf(err) === 412) return { status: 'busy' };
      throw err;
    }
  }
  return { status: 'busy' };
}

/** 生成成功：寫入 used 欄位與附加資訊並清除租約。 */
export async function completeLease(
  tableName: TableName,
  pk: string,
  rk: string,
  patch: (current: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const table = await getTable(tableName);
  for (let attempt = 0; attempt < 8; attempt++) {
    const e = await getEntityOrNull<Record<string, unknown>>(table, pk, rk);
    if (!e) throw new Error(`${tableName}(${rk}) 不存在，無法完成核銷`);
    try {
      await table.updateEntity(
        { ...patch(e), partitionKey: pk, rowKey: rk, lease_id: '', lease_until: '' },
        'Merge',
        { etag: e.etag }
      );
      return;
    } catch (err) {
      if (statusOf(err) === 412) {
        await jitter();
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${tableName}(${rk}) 核銷衝突過多`);
}

/** 生成失敗：釋放租約（只釋放自己持有的那一把）。 */
export async function releaseLease(tableName: TableName, pk: string, rk: string, leaseId: string): Promise<void> {
  const table = await getTable(tableName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const e = await getEntityOrNull<Record<string, unknown> & LeaseFields>(table, pk, rk);
    if (!e || e.lease_id !== leaseId) return;
    try {
      await table.updateEntity({ partitionKey: pk, rowKey: rk, lease_id: '', lease_until: '' }, 'Merge', { etag: e.etag });
      return;
    } catch (err) {
      if (statusOf(err) === 412) {
        await jitter();
        continue;
      }
      throw err;
    }
  }
}

export function emailRowKey(email: string): string {
  // RowKey 直接使用小寫 email；只把 Table Storage 不允許的字元（/ \ # ? 與控制字元）以及 % 轉義，
  // 一般信箱（例如 user@gmail.com）在 Portal 中可直接閱讀
  return email
    .trim()
    .toLowerCase()
    .replace(/[\/\\#?%\u0000-\u001F\u007F-\u009F]/g, (c) => encodeURIComponent(c));
}

/** UserProfiles 的 RowKey（與 EmailOtps 共用同一種編碼） */
export const profileRowKey = emailRowKey;
