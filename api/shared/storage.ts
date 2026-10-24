import { randomUUID } from 'node:crypto';
import { TableClient } from '@azure/data-tables';

/**
 * Azure Table Storage 存取層。
 *
 * - DailyUsage   : PartitionKey = 'Daily'（全站每日成功生成次數）/ 'EmailDaily'（每日寄信封數），RowKey = 台灣日期 YYYY-MM-DD，欄位 usedCount
 * - UserProfiles : PartitionKey = 'User'，RowKey = email（小寫），記錄 free_quota_used、used_at
 * - RedeemCodes  : PartitionKey = 'Code'，RowKey = 序號（SLOW-XXXX-YYYY），欄位 is_used / status 等
 * - EmailOtps    : PartitionKey = 'OTP'，RowKey = email（小寫），首次免費額度的 Email 驗證碼
 *
 * 所有「讀 → 判斷 → 寫」都使用 ETag 樂觀鎖，避免高併發時超賣名額或重複核銷序號。
 */
export const TABLES = {
  DailyUsage: 'DailyUsage',
  UserProfiles: 'UserProfiles',
  RedeemCodes: 'RedeemCodes',
  EmailOtps: 'EmailOtps'
} as const;
export type TableName = (typeof TABLES)[keyof typeof TABLES];

export const PROFILE_PK = 'User';
export const CODE_PK = 'Code';
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
