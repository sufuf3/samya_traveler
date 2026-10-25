import { randomInt, randomUUID } from 'node:crypto';
import { CODE_PK, TABLES, getEntityOrNull, getTable, statusOf } from './storage';

/**
 * RedeemCodes：多次數序號（Portaly 贊助 / Reels 抽獎閨蜜包 / KOC 專屬碼 / 聖誕福袋）
 *
 *   max_uses          最大可用次數（預設 1）
 *   used_count        已成功核銷次數
 *   allow_same_email  true：同一信箱可重複使用（贊助福袋、閨蜜包）
 *                     false：每個信箱限用 1 次（KOC 公開粉絲碼、聖誕公用碼）
 *   used_by_emails    JSON 字串陣列，已使用過此序號的信箱
 *   status            unused ──lockCode()──▶ processing ──markCodeUsed()──▶ unused（尚有次數）/ exhausted（用完）
 *                                  └──────────unlockCode()（額滿 / AI 失敗回滾）──────────┘
 *
 * 一個序號可能同時被多位粉絲使用，所以「鎖」記錄在 pending_locks（JSON 陣列）中，每次生成各持有一把：
 * used_count + 進行中的鎖數 < max_uses 才能再鎖。超過 3 分鐘的鎖視為逾時（例如 Function 中途當掉）自動失效。
 * 所有寫入都帶 ETag，雙開分頁同時送出時不會超額核銷。
 *
 * 舊版一次性序號（只有 is_used / status = "used"）自動視為 max_uses = 1、allow_same_email = true。
 */

export const CODE_LOCK_MS = 3 * 60 * 1000;
/** 4~32 字元的英數與連字號（SLOW-XXXX-YYYY、NANA-SLOW、XMAS-2026…），頭尾不可為連字號 */
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$/;
export const MAX_USES_LIMIT = 500;

export type CodeStatus = 'unused' | 'processing' | 'exhausted';

export interface RedeemCodeEntity {
  code?: string;
  max_uses?: number;
  used_count?: number;
  is_used?: boolean;
  allow_same_email?: boolean;
  used_by_emails?: string;
  pending_locks?: string;
  status?: CodeStatus | 'used';
  locked_at?: string;
  campaign_tag?: string;
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

interface PendingLock {
  id: string;
  at: string;
  email: string;
}

/** 序號不可用的原因 */
export type CodeProblem = 'not_found' | 'exhausted' | 'email_used' | 'processing';

export interface CodeInfo {
  maxUses: number;
  usedCount: number;
  /** 尚未核銷的次數（max_uses - used_count），不扣進行中的鎖 */
  remainingUses: number;
  allowSameEmail: boolean;
  campaignTag: string;
}

export type CodeCheck = ({ status: 'ok' } & CodeInfo) | ({ status: Exclude<CodeProblem, 'not_found'> } & CodeInfo) | { status: 'not_found' };

/** 前後端一致的清理：trim + toUpperCase */
export function cleanCode(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function parseList<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

interface CodeView extends CodeInfo {
  usedBy: string[];
  pending: PendingLock[];
}

function viewOf(e: RedeemCodeEntity, now = Date.now()): CodeView {
  const legacyUsed = e.is_used === true || e.status === 'used' || e.status === 'exhausted';
  const maxUses = Math.max(1, Number(e.max_uses) || 1);
  const usedCount = Math.min(maxUses, Number(e.used_count ?? (legacyUsed ? 1 : 0)) || 0);
  const usedBy = parseList<string>(e.used_by_emails);
  if (!usedBy.length && e.used_by_email) usedBy.push(e.used_by_email);
  const pending = parseList<PendingLock>(e.pending_locks).filter((l) => l && now - Date.parse(l.at) < CODE_LOCK_MS);
  return {
    maxUses,
    usedCount,
    remainingUses: maxUses - usedCount,
    allowSameEmail: e.allow_same_email !== false,
    campaignTag: e.campaign_tag || '',
    usedBy,
    pending
  };
}

function checkView(v: CodeView, email: string): CodeCheck['status'] {
  if (v.usedCount >= v.maxUses) return 'exhausted';
  if (email && !v.allowSameEmail) {
    if (v.usedBy.includes(email)) return 'email_used';
    if (v.pending.some((l) => l.email === email)) return 'processing';
  }
  if (v.usedCount + v.pending.length >= v.maxUses) return 'processing';
  return 'ok';
}

function statusFor(v: { usedCount: number; maxUses: number; pending: PendingLock[] }): CodeStatus {
  if (v.usedCount >= v.maxUses) return 'exhausted';
  return v.pending.length ? 'processing' : 'unused';
}

function infoOf(v: CodeView): CodeInfo {
  const { maxUses, usedCount, remainingUses, allowSameEmail, campaignTag } = v;
  return { maxUses, usedCount, remainingUses, allowSameEmail, campaignTag };
}

/** 唯讀查詢序號是否可用（email 選填；填了才會檢查「每個信箱限用 1 次」）。 */
export async function inspectCode(code: string, email = ''): Promise<CodeCheck> {
  const table = await getTable(TABLES.RedeemCodes);
  const e = await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code);
  if (!e) return { status: 'not_found' };
  const v = viewOf(e);
  return { status: checkView(v, email), ...infoOf(v) } as CodeCheck;
}

export type LockResult = { status: 'ok'; lockId: string } | { status: CodeProblem };

/** 呼叫 AI 前：加入一把進行中的鎖，status → processing（ETag 樂觀鎖）。 */
export async function lockCode(code: string, email: string): Promise<LockResult> {
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const e = await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code);
    if (!e) return { status: 'not_found' };
    const v = viewOf(e);
    const state = checkView(v, email);
    if (state !== 'ok') return { status: state };

    const lockId = randomUUID();
    const now = new Date().toISOString();
    const pending = [...v.pending, { id: lockId, at: now, email }];
    try {
      await table.updateEntity(
        { partitionKey: CODE_PK, rowKey: code, pending_locks: JSON.stringify(pending), status: 'processing', locked_at: now },
        'Merge',
        { etag: e.etag }
      );
      return { status: 'ok', lockId };
    } catch (err) {
      if (statusOf(err) === 412) continue; // 有人同時寫入：重新讀取再判斷一次
      throw err;
    }
  }
  return { status: 'processing' };
}

/**
 * AI 成功回傳合法 JSON 後核銷一次：used_count + 1、信箱加入 used_by_emails，
 * 用完時 is_used = true、status = exhausted。回傳剩餘可用次數。
 */
export async function markCodeUsed(code: string, lockId: string, email: string, extra: Record<string, unknown>): Promise<number> {
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 10; attempt++) {
    const e = await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code);
    if (!e) throw new Error(`RedeemCodes(${code}) 不存在，無法核銷`);
    const v = viewOf(e);
    const pending = v.pending.filter((l) => l.id !== lockId);
    const usedCount = Math.min(v.maxUses, v.usedCount + 1);
    const usedBy = v.usedBy.includes(email) ? v.usedBy : [...v.usedBy, email];
    const nowIso = new Date().toISOString();
    try {
      await table.updateEntity(
        {
          ...extra,
          partitionKey: CODE_PK,
          rowKey: code,
          max_uses: v.maxUses,
          used_count: usedCount,
          is_used: usedCount >= v.maxUses,
          status: statusFor({ usedCount, maxUses: v.maxUses, pending }),
          used_by_emails: JSON.stringify(usedBy),
          used_by_email: email,
          pending_locks: JSON.stringify(pending),
          locked_at: pending.length ? e.locked_at ?? '' : '',
          used_at: nowIso
        },
        'Merge',
        { etag: e.etag }
      );
      return v.maxUses - usedCount;
    } catch (err) {
      if (statusOf(err) === 412) continue;
      throw err;
    }
  }
  throw new Error(`RedeemCodes(${code}) 核銷衝突過多`);
}

/** 額滿或生成失敗：只移除自己持有的那把鎖，used_count 完全不動（零損耗）。 */
export async function unlockCode(code: string, lockId: string): Promise<void> {
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const e = await getEntityOrNull<RedeemCodeEntity>(table, CODE_PK, code);
    if (!e) return;
    const v = viewOf(e);
    if (!parseList<PendingLock>(e.pending_locks).some((l) => l && l.id === lockId)) return;
    const pending = v.pending.filter((l) => l.id !== lockId);
    try {
      await table.updateEntity(
        {
          partitionKey: CODE_PK,
          rowKey: code,
          pending_locks: JSON.stringify(pending),
          status: statusFor({ usedCount: v.usedCount, maxUses: v.maxUses, pending }),
          locked_at: pending.length ? e.locked_at ?? '' : ''
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
}

export const CODE_MESSAGES: Record<CodeProblem, string> = {
  not_found: '查無此序號，請確認序號是否輸入正確。',
  exhausted: '此序號的可用次數已經全部用完囉！',
  email_used: '此活動專屬序號每個信箱限體驗一次喔！',
  processing: '此序號正在生成行程中，請稍候 1~2 分鐘再試（若超過 3 分鐘仍未完成會自動釋放）。'
};

/* ------------------------------------------------------------------ */
/* 發碼（Portaly 贊助 /api/generateCode 與管理員戰情室 /api/adminStats 共用） */
/* ------------------------------------------------------------------ */

/** 隨機序號字元：排除易混淆的 0/O、1/I/L */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomBlock(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** 前綴只保留英數（最多 10 碼），預設 SLOW → SLOW-XXXX-YYYY */
export function cleanPrefix(value: unknown): string {
  return cleanCode(value).replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'SLOW';
}

export function randomCode(prefix = 'SLOW'): string {
  return `${cleanPrefix(prefix)}-${randomBlock(4)}-${randomBlock(4)}`;
}

/** 活動標籤：英數、底線、連字號，最多 32 碼（例如 PORTALY、REELS_GIVEAWAY、KOC_NANA、XMAS） */
export function cleanCampaignTag(value: unknown, fallback = ''): string {
  return cleanCode(value).replace(/[^A-Z0-9_-]/g, '').slice(0, 32) || fallback;
}

/** 一鍵帶入序號的 Magic Link（前端讀取 ?code= 後自動填入並清除網址參數） */
export function magicLink(code: string): string {
  const base = (process.env.SLOWMATE_APP_URL || 'https://samya-traveler.github.io/slowmate/').replace(/\/?$/, '/');
  return `${base}?code=${encodeURIComponent(code)}`;
}

export interface NewCodeOptions {
  maxUses: number;
  allowSameEmail: boolean;
  campaignTag: string;
  source: string;
  extra?: Partial<RedeemCodeEntity>;
}

function newCodeEntity(code: string, opts: NewCodeOptions) {
  return {
    ...opts.extra,
    partitionKey: CODE_PK,
    rowKey: code,
    code,
    max_uses: Math.min(MAX_USES_LIMIT, Math.max(1, Math.floor(opts.maxUses) || 1)),
    used_count: 0,
    is_used: false,
    allow_same_email: opts.allowSameEmail,
    used_by_emails: '[]',
    pending_locks: '[]',
    status: 'unused' as CodeStatus,
    locked_at: '',
    campaign_tag: opts.campaignTag,
    source: opts.source,
    created_at: new Date().toISOString(),
    used_at: ''
  };
}

/** 建立指定代碼（例如 NANA-SLOW）。代碼已存在時回傳 false，不會覆寫既有序號。 */
export async function insertCode(code: string, opts: NewCodeOptions): Promise<boolean> {
  const table = await getTable(TABLES.RedeemCodes);
  try {
    await table.createEntity(newCodeEntity(code, opts));
    return true;
  } catch (err) {
    if (statusOf(err) === 409) return false;
    throw err;
  }
}

/** 建立一組隨機序號（撞號自動重抽）。 */
export async function createRandomCode(prefix: string, opts: NewCodeOptions): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomCode(prefix);
    if (await insertCode(candidate, opts)) return candidate;
  }
  throw new Error('序號連續碰撞，無法產生');
}
