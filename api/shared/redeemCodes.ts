import { randomUUID } from 'node:crypto';
import { CODE_PK, TABLES, getEntityOrNull, getTable, statusOf } from './storage';

/**
 * RedeemCodes 序號狀態機（認碼不認信箱：任何信箱持有有效序號都能兌換，可轉贈旅伴）
 *
 *   unused ──lockCode()──▶ processing ──markCodeUsed()──▶ used
 *     ▲                        │
 *     └──────unlockCode()──────┘   （每日額滿 / Claude 失敗時回滾）
 *
 * - status = "processing" 且 locked_at 未滿 3 分鐘：視為生成中，其他請求回 409
 * - status = "processing" 但已超過 3 分鐘：視為逾時（例如 Function 中途當掉），可重新鎖定使用
 * - is_used = true 或 status = "used"：已核銷
 * 所有寫入都帶 ETag，雙開分頁同時送出時只有一個請求能拿到鎖。
 */

export const CODE_LOCK_MS = 3 * 60 * 1000;
export const CODE_RE = /^SLOW-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export type CodeStatus = 'unused' | 'processing' | 'used';

export interface RedeemCodeEntity {
  code?: string;
  is_used?: boolean;
  status?: CodeStatus;
  locked_at?: string;
  lock_id?: string;
  sponsor_email?: string;
  sponsor_name?: string;
  amount?: number;
  tier?: string;
  currency?: string;
  order_id?: string;
  source?: string;
  email_sent?: boolean;
  created_at?: string;
  used_at?: string;
  used_by_email?: string;
  used_for_destination?: string;
}

export type CodeState = CodeStatus | 'not_found';

/** 前後端一致的清理：trim + toUpperCase */
export function cleanCode(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function isFreshLock(e: RedeemCodeEntity, now = Date.now()): boolean {
  if (e.status !== 'processing' || !e.locked_at) return false;
  const t = Date.parse(e.locked_at);
  return Number.isFinite(t) && now - t < CODE_LOCK_MS;
}

export function codeStateOf(e: RedeemCodeEntity | null): CodeState {
  if (!e) return 'not_found';
  if (e.is_used === true || e.status === 'used') return 'used';
  if (isFreshLock(e)) return 'processing';
  return 'unused'; // 包含逾時的 processing
}

/** 唯讀查詢序號狀態。 */
export async function inspectCode(code: string): Promise<CodeState> {
  const table = await getTable(TABLES.RedeemCodes);
  return codeStateOf(await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code));
}

export type LockResult = { status: 'ok'; lockId: string } | { status: Exclude<CodeState, 'unused'> };

/** 呼叫 Claude 前：unused → processing（ETag 樂觀鎖）。 */
export async function lockCode(code: string): Promise<LockResult> {
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 5; attempt++) {
    const e = await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code);
    const state = codeStateOf(e);
    if (state !== 'unused') return { status: state };

    const lockId = randomUUID();
    try {
      await table.updateEntity(
        { partitionKey: CODE_PK, rowKey: code, status: 'processing', locked_at: new Date().toISOString(), lock_id: lockId },
        'Merge',
        { etag: e!.etag }
      );
      return { status: 'ok', lockId };
    } catch (err) {
      if (statusOf(err) === 412) continue; // 有人搶先寫入：重新讀取，通常會變成 processing → 409
      throw err;
    }
  }
  return { status: 'processing' };
}

/** Claude 成功回傳合法 JSON 後：processing → used。 */
export async function markCodeUsed(code: string, extra: Record<string, unknown>): Promise<void> {
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const e = await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code);
    if (!e) throw new Error(`RedeemCodes(${code}) 不存在，無法核銷`);
    try {
      await table.updateEntity(
        {
          ...extra,
          partitionKey: CODE_PK,
          rowKey: code,
          is_used: true,
          status: 'used',
          used_at: new Date().toISOString(),
          locked_at: '',
          lock_id: ''
        },
        'Merge',
        { etag: e.etag }
      );
      return;
    } catch (err) {
      if (statusOf(err) === 412) continue;
      throw err;
    }
  }
  throw new Error(`RedeemCodes(${code}) 核銷衝突過多`);
}

/** 額滿或生成失敗：processing → unused（只回滾自己持有的鎖，絕不動到已核銷的序號）。 */
export async function unlockCode(code: string, lockId: string): Promise<void> {
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 5; attempt++) {
    const e = await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code);
    if (!e || e.lock_id !== lockId || e.is_used === true || e.status === 'used') return;
    try {
      await table.updateEntity(
        { partitionKey: CODE_PK, rowKey: code, is_used: false, status: 'unused', locked_at: '', lock_id: '' },
        'Merge',
        { etag: e.etag }
      );
      return;
    } catch (err) {
      if (statusOf(err) === 412) continue;
      throw err;
    }
  }
}

export const CODE_MESSAGES: Record<Exclude<CodeState, 'unused'>, string> = {
  not_found: '查無此序號，請確認信件中的序號是否輸入正確。',
  used: '此序號已被使用過了，一組序號僅限生成一次。',
  processing: '此序號正在生成行程中，請勿重複送出（約 20~40 秒，若超過 3 分鐘仍未完成會自動釋放）。'
};
