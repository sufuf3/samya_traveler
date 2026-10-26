import { randomInt, randomUUID } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { CODE_PK, LEGACY_CODE_PK, TABLES, getEntityOrNull, getTable, statusOf } from './storage';

/**
 * RedeemCodes：多次數序號（Portaly 贊助方案 / 戰情室批次碼 / 活動公用碼）
 *
 *   PartitionKey    "RedeemCode"（2026/10 以前的序號在 "Code"，讀取時兩邊都查，更新時寫回原本那一列）
 *   RowKey          序號（大寫、去空白）
 *   OwnerEmail      買家 Email（小寫）；戰情室預產碼與公用碼為 ""
 *   Amount          贊助金額（行銷活動碼為 0）
 *   TotalUses       總可用次數
 *   RemainingUses   剩餘可用次數
 *   AllowSameEmail  true ：不限信箱，誰都可以用到次數用完（單次碼、聖誕雙人福袋、Reels 抽獎碼…）
 *                   false：買家本人可重複使用全部次數；其他信箱（或沒有 OwnerEmail 的公用碼）每個限用 1 次
 *   UsedByEmails    JSON 字串陣列，用過此序號的「非買家」信箱
 *   CampaignTag     PORTALY_NORMAL / PORTALY_XMAS / REELS_BIRTH / THREADS_EARLY100 / NOV_GIFT…
 *   IsUsed          RemainingUses <= 0 時為 true
 *
 * 成功才扣：生成前在 PendingLocks（JSON 陣列）加一把鎖，AI 成功回傳後才 RemainingUses - 1；
 * 失敗只移除自己的鎖。RemainingUses - 進行中的鎖數 > 0 才能再鎖，超過 3 分鐘的鎖視為逾時自動失效。
 * 所有寫入都帶 ETag，多人同時使用同一組序號也不會超扣。
 *
 * 向下相容：舊欄位 max_uses / used_count / allow_same_email / used_by_emails / campaign_tag / sponsor_email 會自動換算；
 * 最早的一次性序號（只有 is_used）視為 RemainingUses = IsUsed ? 0 : 1。
 */

export const CODE_LOCK_MS = 3 * 60 * 1000;
/** 4~32 字元的英數與連字號（SM5-XXXX-YYYY、NOV-VIP、XMAS-2026…），頭尾不可為連字號 */
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$/;
export const MAX_USES_LIMIT = 500;

export type CodeStatus = 'unused' | 'processing' | 'exhausted';

export interface RedeemCodeEntity {
  Code?: string;
  OwnerEmail?: string;
  Amount?: number;
  TotalUses?: number;
  RemainingUses?: number;
  AllowSameEmail?: boolean;
  UsedByEmails?: string;
  CampaignTag?: string;
  IsUsed?: boolean;
  PlanName?: string;
  PendingLocks?: string;
  Status?: CodeStatus;
  LockedAt?: string;
  SponsorName?: string;
  Currency?: string;
  OrderId?: string;
  Source?: string;
  EmailSent?: boolean;
  CreatedAt?: string;
  UsedAt?: string;
  LastUsedByEmail?: string;
  LastDestination?: string;
  // 舊欄位（PartitionKey "Code"）
  max_uses?: number;
  used_count?: number;
  is_used?: boolean;
  allow_same_email?: boolean;
  used_by_emails?: string;
  used_by_email?: string;
  pending_locks?: string;
  status?: string;
  campaign_tag?: string;
  sponsor_email?: string;
  amount?: number;
  order_id?: string;
  source?: string;
  created_at?: string;
}

interface PendingLock {
  id: string;
  at: string;
  email: string;
}

/**
 * 序號不可用的原因：
 *   not_found      查無此序號
 *   exhausted      額度已全數用完
 *   companion_used 旅伴分享序號（有 OwnerEmail）：此信箱已體驗過 1 次
 *   email_used     活動公用碼（無 OwnerEmail）：此信箱已體驗過 1 次
 *   processing     剩餘次數都正在生成中
 */
export type CodeProblem = 'not_found' | 'exhausted' | 'companion_used' | 'email_used' | 'processing';

export interface CodeView {
  partitionKey: string;
  code: string;
  ownerEmail: string;
  amount: number;
  totalUses: number;
  remainingUses: number;
  allowSameEmail: boolean;
  usedBy: string[];
  campaignTag: string;
  planName: string;
  pending: PendingLock[];
  createdAt: string;
}

export type CodeCheck = { status: 'ok' | Exclude<CodeProblem, 'not_found'>; view: CodeView; isOwner: boolean } | { status: 'not_found' };

/** 前後端一致的清理：trim + toUpperCase */
export function cleanCode(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

export function cleanEmail(value: unknown): string {
  return String(value ?? '').toLowerCase().trim();
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

function num(v: unknown): number | undefined {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n;
}

/** 新舊欄位統一換算成同一種檢視（PascalCase 欄位優先） */
export function viewOf(e: RedeemCodeEntity & { partitionKey?: string; rowKey?: string }, now = Date.now()): CodeView {
  const legacyUsed = e.is_used === true || e.status === 'used' || e.status === 'exhausted';
  const totalUses = Math.max(1, Math.floor(num(e.TotalUses) ?? num(e.max_uses) ?? 1));
  let remaining = num(e.RemainingUses);
  if (remaining === undefined) {
    const usedCount = num(e.used_count);
    remaining = usedCount !== undefined ? totalUses - usedCount : e.IsUsed === true || legacyUsed ? 0 : 1;
  }
  const usedBy = parseList<string>(e.UsedByEmails ?? e.used_by_emails);
  if (!usedBy.length && e.used_by_email) usedBy.push(e.used_by_email);
  const pending = parseList<PendingLock>(e.PendingLocks ?? e.pending_locks).filter((l) => l && now - Date.parse(l.at) < CODE_LOCK_MS);
  const source = e.Source ?? e.source;
  return {
    partitionKey: e.partitionKey || CODE_PK,
    code: e.rowKey || e.Code || '',
    ownerEmail: cleanEmail(e.OwnerEmail ?? e.sponsor_email),
    amount: num(e.Amount) ?? num(e.amount) ?? 0,
    totalUses,
    remainingUses: Math.max(0, Math.min(totalUses, Math.floor(remaining))),
    allowSameEmail: (e.AllowSameEmail ?? e.allow_same_email) !== false,
    usedBy,
    campaignTag: e.CampaignTag || e.campaign_tag || (source === 'portaly' ? 'PORTALY' : 'UNTAGGED'),
    planName: e.PlanName || '',
    pending,
    createdAt: e.CreatedAt || e.created_at || ''
  };
}

function isOwnerOf(v: CodeView, email: string): boolean {
  return !!email && !!v.ownerEmail && email === v.ownerEmail;
}

/** 呼叫 AI 之前的權限檢查（email 已轉小寫；空字串代表只查剩餘次數） */
function checkView(v: CodeView, email: string): CodeCheck['status'] {
  if (v.remainingUses <= 0) return 'exhausted';
  if (email && !v.allowSameEmail && !isOwnerOf(v, email)) {
    if (v.usedBy.includes(email)) return v.ownerEmail ? 'companion_used' : 'email_used';
    if (v.pending.some((l) => l.email === email)) return 'processing';
  }
  if (v.remainingUses - v.pending.length <= 0) return 'processing';
  return 'ok';
}

function statusFor(remaining: number, pending: PendingLock[]): CodeStatus {
  if (remaining <= 0) return 'exhausted';
  return pending.length ? 'processing' : 'unused';
}

/** 依序查新舊 PartitionKey，回傳實體（含 ETag）與所在的 PartitionKey */
async function findEntity(table: TableClient, code: string) {
  for (const pk of [CODE_PK, LEGACY_CODE_PK]) {
    const e = await getEntityOrNull<RedeemCodeEntity>(table, pk, code);
    if (e) return e;
  }
  return null;
}

/** 唯讀查詢序號是否可用。 */
export async function inspectCode(code: string, email = ''): Promise<CodeCheck> {
  const table = await getTable(TABLES.RedeemCodes);
  const e = await findEntity(table, code);
  if (!e) return { status: 'not_found' };
  const view = viewOf(e);
  const mail = cleanEmail(email);
  return { status: checkView(view, mail), view, isOwner: isOwnerOf(view, mail) };
}

export type LockResult = { status: 'ok'; lockId: string } | { status: CodeProblem };

/** 呼叫 AI 前：加入一把進行中的鎖（ETag 樂觀鎖），次數尚未扣除。 */
export async function lockCode(code: string, email: string): Promise<LockResult> {
  const table = await getTable(TABLES.RedeemCodes);
  const mail = cleanEmail(email);
  for (let attempt = 0; attempt < 8; attempt++) {
    const e = await findEntity(table, code);
    if (!e) return { status: 'not_found' };
    const v = viewOf(e);
    const state = checkView(v, mail);
    if (state !== 'ok') return { status: state };

    const lockId = randomUUID();
    const now = new Date().toISOString();
    const pending = [...v.pending, { id: lockId, at: now, email: mail }];
    try {
      await table.updateEntity(
        { partitionKey: e.partitionKey, rowKey: code, PendingLocks: JSON.stringify(pending), Status: 'processing', LockedAt: now },
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
 * 成功才扣：AI 回傳合法行程 JSON 之後 RemainingUses - 1（用完時 IsUsed = true），
 * 非買家信箱加入 UsedByEmails。舊資料列會一併補上新欄位。回傳剩餘次數。
 */
export async function markCodeUsed(code: string, lockId: string, email: string, destination: string): Promise<number> {
  const table = await getTable(TABLES.RedeemCodes);
  const mail = cleanEmail(email);
  for (let attempt = 0; attempt < 10; attempt++) {
    const e = await findEntity(table, code);
    if (!e) throw new Error(`RedeemCodes(${code}) 不存在，無法核銷`);
    const v = viewOf(e);
    const pending = v.pending.filter((l) => l.id !== lockId);
    const remaining = Math.max(0, v.remainingUses - 1);
    const usedBy = isOwnerOf(v, mail) || v.usedBy.includes(mail) ? v.usedBy : [...v.usedBy, mail];
    try {
      await table.updateEntity(
        {
          partitionKey: e.partitionKey,
          rowKey: code,
          OwnerEmail: v.ownerEmail,
          Amount: v.amount,
          TotalUses: v.totalUses,
          RemainingUses: remaining,
          AllowSameEmail: v.allowSameEmail,
          UsedByEmails: JSON.stringify(usedBy),
          CampaignTag: v.campaignTag,
          IsUsed: remaining <= 0,
          Status: statusFor(remaining, pending),
          PendingLocks: JSON.stringify(pending),
          LockedAt: pending.length ? e.LockedAt ?? '' : '',
          UsedAt: new Date().toISOString(),
          LastUsedByEmail: mail,
          LastDestination: destination
        },
        'Merge',
        { etag: e.etag }
      );
      return remaining;
    } catch (err) {
      if (statusOf(err) === 412) continue;
      throw err;
    }
  }
  throw new Error(`RedeemCodes(${code}) 核銷衝突過多`);
}

/** 額滿或生成失敗：只移除自己持有的那把鎖，RemainingUses 完全不動（零損耗）。 */
export async function unlockCode(code: string, lockId: string): Promise<void> {
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const e = await findEntity(table, code);
    if (!e) return;
    if (!parseList<PendingLock>(e.PendingLocks ?? e.pending_locks).some((l) => l && l.id === lockId)) return;
    const v = viewOf(e);
    const pending = v.pending.filter((l) => l.id !== lockId);
    try {
      await table.updateEntity(
        {
          partitionKey: e.partitionKey,
          rowKey: code,
          PendingLocks: JSON.stringify(pending),
          Status: statusFor(v.remainingUses, pending),
          LockedAt: pending.length ? e.LockedAt ?? '' : ''
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
  not_found: '🌿 查無此序號，請確認序號是否輸入正確。',
  exhausted: '🌿 此序號額度已全數使用完畢（若是限量活動公用碼，代表名額已被搶光囉）！',
  companion_used: '🌿 這組旅伴分享序號您已經體驗過 1 次囉！若想繼續微調行程，歡迎贊助屬於自己的慢旅序號 ☕（本次未扣除額度）。',
  email_used: '🌿 這組活動限量 VIP 序號每個信箱限體驗 1 次喔！若喜歡 SlowMate，歡迎贊助解鎖更多專屬額度 ☕（本次未扣除額度）。',
  processing: '此序號正在生成行程中，請稍候 1~2 分鐘再試（若超過 3 分鐘仍未完成會自動釋放）。'
};

/* ------------------------------------------------------------------ */
/* 發碼（Portaly 贊助 /api/generateCode、戰情室 /api/generateCode 與 /api/dashboard-stats 共用） */
/* ------------------------------------------------------------------ */

/** 隨機序號字元：排除易混淆的 0/O、1/I/L */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomBlock(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** 前綴只保留英數（最多 10 碼）："GIFT10-" → GIFT10 → GIFT10-XXXX-YYYY；預設 SLOW */
export function cleanPrefix(value: unknown): string {
  return cleanCode(value).replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'SLOW';
}

export function randomCode(prefix = 'SLOW'): string {
  return `${cleanPrefix(prefix)}-${randomBlock(4)}-${randomBlock(4)}`;
}

/** 活動標籤：英數、底線、連字號，最多 32 碼 */
export function cleanCampaignTag(value: unknown, fallback = ''): string {
  return cleanCode(value).replace(/[^A-Z0-9_-]/g, '').slice(0, 32) || fallback;
}

/** 一鍵帶入序號的 Magic Link：?code=…（買家序號另帶 &email=…，前端會一併填入） */
export function magicLink(code: string, email = ''): string {
  const base = (process.env.SLOWMATE_APP_URL || 'https://samya-traveler.github.io/slowmate/').replace(/\/?$/, '/');
  return `${base}?code=${encodeURIComponent(code)}${email ? `&email=${encodeURIComponent(email)}` : ''}`;
}

export interface NewCodeOptions {
  totalUses: number;
  allowSameEmail: boolean;
  campaignTag: string;
  source: 'portaly' | 'admin';
  ownerEmail?: string;
  amount?: number;
  planName?: string;
  extra?: Partial<RedeemCodeEntity>;
}

function clampUses(n: number): number {
  return Math.min(MAX_USES_LIMIT, Math.max(1, Math.floor(n) || 1));
}

function newCodeEntity(code: string, opts: NewCodeOptions) {
  const total = clampUses(opts.totalUses);
  return {
    ...opts.extra,
    partitionKey: CODE_PK,
    rowKey: code,
    Code: code,
    OwnerEmail: cleanEmail(opts.ownerEmail),
    Amount: opts.amount ?? 0,
    TotalUses: total,
    RemainingUses: total,
    AllowSameEmail: opts.allowSameEmail,
    UsedByEmails: '[]',
    CampaignTag: opts.campaignTag,
    IsUsed: false,
    PlanName: opts.planName ?? '',
    PendingLocks: '[]',
    Status: 'unused' as CodeStatus,
    LockedAt: '',
    Source: opts.source,
    CreatedAt: new Date().toISOString(),
    UsedAt: ''
  };
}

/** 建立指定代碼。代碼已存在（新舊 PartitionKey 任一）時回傳 false，不會覆寫。 */
export async function insertCode(code: string, opts: NewCodeOptions): Promise<boolean> {
  const table = await getTable(TABLES.RedeemCodes);
  if (await getEntityOrNull(table, LEGACY_CODE_PK, code)) return false;
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

/**
 * 建立或更新公用序號（例如 NOV-VIP）：
 *   不存在 → 新建；已存在 → 改成新的 TotalUses / AllowSameEmail / CampaignTag，
 *   已用掉的次數照算（RemainingUses = 新 TotalUses - 已用次數），UsedByEmails 保留。
 */
export async function upsertCustomCode(code: string, opts: NewCodeOptions): Promise<{ created: boolean; view: CodeView }> {
  if (await insertCode(code, opts)) {
    const table = await getTable(TABLES.RedeemCodes);
    return { created: true, view: viewOf((await findEntity(table, code))!) };
  }
  const table = await getTable(TABLES.RedeemCodes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const e = await findEntity(table, code);
    if (!e) return upsertCustomCode(code, opts);
    const v = viewOf(e);
    const total = clampUses(opts.totalUses);
    const used = v.totalUses - v.remainingUses;
    const remaining = Math.max(0, total - used);
    try {
      await table.updateEntity(
        {
          partitionKey: e.partitionKey,
          rowKey: code,
          TotalUses: total,
          RemainingUses: remaining,
          AllowSameEmail: opts.allowSameEmail,
          CampaignTag: opts.campaignTag,
          OwnerEmail: v.ownerEmail,
          UsedByEmails: JSON.stringify(v.usedBy),
          IsUsed: remaining <= 0,
          Status: statusFor(remaining, v.pending)
        },
        'Merge',
        { etag: e.etag }
      );
      return { created: false, view: viewOf((await findEntity(table, code))!) };
    } catch (err) {
      if (statusOf(err) === 412) continue;
      throw err;
    }
  }
  throw new Error(`RedeemCodes(${code}) 更新衝突過多`);
}

/** 依 Portaly 訂單編號找已發過的序號（冪等；新舊欄位都查） */
export async function findCodeByOrderId(orderId: string): Promise<(RedeemCodeEntity & { rowKey?: string; partitionKey?: string }) | null> {
  const table = await getTable(TABLES.RedeemCodes);
  const filters = [
    `PartitionKey eq '${CODE_PK}' and OrderId eq '${orderId.replace(/'/g, "''")}'`,
    `PartitionKey eq '${LEGACY_CODE_PK}' and order_id eq '${orderId.replace(/'/g, "''")}'`
  ];
  for (const filter of filters) {
    for await (const e of table.listEntities<RedeemCodeEntity>({ queryOptions: { filter } })) return e;
  }
  return null;
}

/** 列出所有序號（戰情室統計用，新舊 PartitionKey 都列） */
export async function* listAllCodes(): AsyncGenerator<CodeView> {
  const table = await getTable(TABLES.RedeemCodes);
  for (const pk of [CODE_PK, LEGACY_CODE_PK]) {
    for await (const e of table.listEntities<RedeemCodeEntity>({ queryOptions: { filter: `PartitionKey eq '${pk}'` } })) {
      yield viewOf(e);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 戰情室產碼（mode: "batch" 批次 / "custom" 指定公用碼）                    */
/* ------------------------------------------------------------------ */

export class AdminCodeInputError extends Error {}

export interface AdminGenerateInput {
  mode?: unknown;
  prefix?: unknown;
  count?: unknown;
  max_uses?: unknown;
  allow_same_email?: unknown;
  campaign_tag?: unknown;
  custom_code?: unknown;
  code?: unknown;
}

export interface GeneratedCode {
  code: string;
  magic_link: string;
  max_uses: number;
  remaining_uses: number;
  allow_same_email: boolean;
  campaign_tag: string;
  updated?: boolean;
}

const MAX_BATCH = 100;

function intInRange(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AdminCodeInputError(`${label} 需為 ${min}~${max} 的整數。`);
  return n;
}

/** 戰情室產碼：不寄信、OwnerEmail 為空，回傳序號清單與 Magic Link */
export async function adminGenerateCodes(body: AdminGenerateInput): Promise<{ mode: 'batch' | 'custom'; codes: GeneratedCode[] }> {
  const mode = body.mode === 'custom' ? 'custom' : 'batch'; // 舊版戰情室送 'random'，視同 batch
  const maxUses = intInRange(body.max_uses ?? 1, 1, MAX_USES_LIMIT, 'max_uses（每組可用次數）');
  const allowSameEmail = body.allow_same_email === true || body.allow_same_email === 'true';
  const campaignTag = cleanCampaignTag(body.campaign_tag, 'MANUAL');
  const opts: NewCodeOptions = { totalUses: maxUses, allowSameEmail, campaignTag, source: 'admin', ownerEmail: '', amount: 0 };
  const out = (code: string, remaining: number, updated?: boolean): GeneratedCode => ({
    code,
    magic_link: magicLink(code),
    max_uses: maxUses,
    remaining_uses: remaining,
    allow_same_email: allowSameEmail,
    campaign_tag: campaignTag,
    ...(updated ? { updated: true } : {})
  });

  if (mode === 'custom') {
    const code = cleanCode(body.custom_code ?? body.code);
    if (!CODE_RE.test(code)) {
      throw new AdminCodeInputError('自訂代碼需為 4~32 碼英數字與連字號（例如 NOV-VIP、XMAS-2026），頭尾不可為連字號。');
    }
    const { created, view } = await upsertCustomCode(code, opts);
    return { mode, codes: [out(code, view.remainingUses, !created)] };
  }

  const count = intInRange(body.count ?? 1, 1, MAX_BATCH, 'count（組數）');
  const prefix = cleanPrefix(body.prefix);
  const codes: GeneratedCode[] = [];
  for (let i = 0; i < count; i++) codes.push(out(await createRandomCode(prefix, opts), maxUses));
  return { mode, codes };
}
