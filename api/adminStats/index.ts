import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { BadRequestError, adminStatus, envInt, json, preflight, readJsonBody } from '../shared/http';
import {
  CODE_RE,
  MAX_USES_LIMIT,
  NewCodeOptions,
  RedeemCodeEntity,
  cleanCampaignTag,
  cleanCode,
  cleanPrefix,
  createRandomCode,
  insertCode,
  magicLink
} from '../shared/redeemCodes';
import {
  CODE_PK,
  EMAIL_COUNTER,
  PLAN_COUNTER,
  PROFILE_PK,
  TABLES,
  getTable,
  poolLimits,
  poolRemaining,
  readCounter,
  readPoolUsage,
  taipeiDateKey
} from '../shared/storage';

/**
 * 管理員戰情室（Header x-admin-secret = App Setting ADMIN_SECRET）
 *
 * 路由為 /api/dashboard-stats：Azure Functions 保留以 admin 開頭的路由給主機管理 API，/api/adminStats 會被擋成 404。
 *
 * GET  /api/dashboard-stats
 *   { date_key, today: { free_used, free_limit, code_used, vip_limit, vip_whitelist_used, ...剩餘名額 },
 *     trend: 近 7 日 [{ date, free_used, code_used, vip_whitelist_used, total }],
 *     total_users, free_trial_users, emails_sent_today,
 *     total_codes, campaigns: 各 campaign_tag 核銷統計, top_codes: 序號核銷排行榜 }
 *
 * POST /api/dashboard-stats   批次產生行銷序號
 *   隨機批次：{ mode: 'random', count: 20, max_uses: 1, prefix: 'REELS', allow_same_email: false, campaign_tag: 'REELS_GIVEAWAY' }
 *   指定代碼：{ mode: 'custom', code: 'NANA-SLOW', max_uses: 50, allow_same_email: false, campaign_tag: 'KOC_NANA' }
 *   201 { codes: [{ code, magic_link, max_uses, allow_same_email, campaign_tag }] }
 *   409 { error: 'code_exists' }   指定代碼已存在（不會覆寫既有序號）
 *
 *   401 { error: 'unauthorized' }  未帶或帶錯金鑰
 */

const MAX_BATCH = 100;
const TREND_DAYS = 7;
const TOP_CODES = 20;

function dateKeysBack(days: number): string[] {
  const now = Date.now();
  return Array.from({ length: days }, (_, i) => taipeiDateKey(new Date(now - (days - 1 - i) * 86400000)));
}

interface CampaignStat {
  campaign_tag: string;
  codes: number;
  capacity: number;
  used: number;
  exhausted: number;
}

async function handleGet(request: HttpRequest): Promise<HttpResponseInit> {
  const dateKey = taipeiDateKey();
  const { free, vip } = poolLimits();
  const keys = dateKeysBack(TREND_DAYS);

  // 近 7 日雙水池用量（一次查詢 PartitionKey 'Daily' 的日期範圍）
  const daily = await getTable(TABLES.DailyUsage);
  const byDate = new Map<string, Record<string, unknown>>();
  for await (const e of daily.listEntities<Record<string, unknown>>({
    queryOptions: { filter: odata`PartitionKey eq ${PLAN_COUNTER} and RowKey ge ${keys[0]} and RowKey le ${keys[keys.length - 1]}` }
  })) {
    byDate.set(e.rowKey as string, e);
  }
  const trend = keys.map((date) => {
    const e = byDate.get(date);
    const freeUsed = Number(e?.free_used ?? e?.usedCount) || 0;
    const codeUsed = Number(e?.code_used) || 0;
    const whitelist = Number(e?.vip_whitelist_used) || 0;
    return { date, free_used: freeUsed, code_used: codeUsed, vip_whitelist_used: whitelist, total: freeUsed + codeUsed + whitelist };
  });

  const usage = await readPoolUsage(dateKey);

  // 用戶數
  const profiles = await getTable(TABLES.UserProfiles);
  let totalUsers = 0;
  let freeTrialUsers = 0;
  for await (const e of profiles.listEntities<{ free_quota_used?: boolean }>({
    queryOptions: { filter: odata`PartitionKey eq ${PROFILE_PK}`, select: ['free_quota_used'] }
  })) {
    totalUsers++;
    if (e.free_quota_used === true) freeTrialUsers++;
  }

  // 序號：各活動核銷統計 + 排行榜
  const codesTable = await getTable(TABLES.RedeemCodes);
  const campaigns = new Map<string, CampaignStat>();
  const codes: { code: string; campaign_tag: string; used_count: number; max_uses: number; allow_same_email: boolean; status: string; created_at: string }[] = [];
  for await (const e of codesTable.listEntities<RedeemCodeEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${CODE_PK}`,
      select: ['RowKey', 'campaign_tag', 'source', 'max_uses', 'used_count', 'is_used', 'status', 'allow_same_email', 'created_at']
    }
  })) {
    const legacyUsed = e.is_used === true || e.status === 'used';
    const maxUses = Math.max(1, Number(e.max_uses) || 1);
    const used = Math.min(maxUses, Number(e.used_count ?? (legacyUsed ? 1 : 0)) || 0);
    const tag = e.campaign_tag || (e.source === 'portaly' ? 'PORTALY' : 'UNTAGGED');
    const stat = campaigns.get(tag) ?? { campaign_tag: tag, codes: 0, capacity: 0, used: 0, exhausted: 0 };
    stat.codes++;
    stat.capacity += maxUses;
    stat.used += used;
    if (used >= maxUses) stat.exhausted++;
    campaigns.set(tag, stat);
    codes.push({
      code: e.rowKey as string,
      campaign_tag: tag,
      used_count: used,
      max_uses: maxUses,
      allow_same_email: e.allow_same_email !== false,
      status: used >= maxUses ? 'exhausted' : (e.status as string) === 'processing' ? 'processing' : 'unused',
      created_at: e.created_at || ''
    });
  }
  codes.sort((a, b) => b.used_count - a.used_count || b.created_at.localeCompare(a.created_at));

  return json(request, 200, {
    date_key: dateKey,
    timezone: 'Asia/Taipei',
    today: { ...usage, free_limit: free, vip_limit: vip, ...poolRemaining(usage) },
    trend,
    total_users: totalUsers,
    free_trial_users: freeTrialUsers,
    emails_sent_today: await readCounter(EMAIL_COUNTER, dateKey),
    email_daily_cap: envInt('EMAIL_DAILY_CAP', 400),
    total_codes: codes.length,
    campaigns: [...campaigns.values()].sort((a, b) => b.used - a.used || b.codes - a.codes),
    top_codes: codes.slice(0, TOP_CODES)
  });
}

interface GenerateBody {
  mode?: unknown;
  count?: unknown;
  max_uses?: unknown;
  prefix?: unknown;
  code?: unknown;
  allow_same_email?: unknown;
  campaign_tag?: unknown;
}

function intInRange(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestError(`${label} 需為 ${min}~${max} 的整數。`);
  return n;
}

async function handlePost(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const body = await readJsonBody<GenerateBody>(request, 4 * 1024);
  const mode = body.mode === 'custom' ? 'custom' : 'random';
  const maxUses = intInRange(body.max_uses ?? 1, 1, MAX_USES_LIMIT, 'max_uses（每組可用次數）');
  const allowSameEmail = body.allow_same_email === true || body.allow_same_email === 'true';
  const campaignTag = cleanCampaignTag(body.campaign_tag, 'MANUAL');
  const opts: NewCodeOptions = { maxUses, allowSameEmail, campaignTag, source: 'admin' };

  let created: string[];
  if (mode === 'custom') {
    const code = cleanCode(body.code);
    if (!CODE_RE.test(code)) {
      throw new BadRequestError('自訂代碼需為 4~32 碼英數字與連字號（例如 NANA-SLOW、XMAS-2026），頭尾不可為連字號。');
    }
    if (!(await insertCode(code, opts))) {
      return json(request, 409, { error: 'code_exists', message: `代碼 ${code} 已存在，為避免覆寫既有序號請換一個代碼。` });
    }
    created = [code];
  } else {
    const count = intInRange(body.count ?? 1, 1, MAX_BATCH, 'count（組數）');
    const prefix = cleanPrefix(body.prefix);
    created = [];
    for (let i = 0; i < count; i++) created.push(await createRandomCode(prefix, opts));
  }

  context.log(`[adminStats] created ${created.length} code(s) mode=${mode} campaign=${campaignTag} max_uses=${maxUses} allow_same_email=${allowSameEmail}`);
  return json(request, 201, {
    codes: created.map((code) => ({ code, magic_link: magicLink(code), max_uses: maxUses, allow_same_email: allowSameEmail, campaign_tag: campaignTag }))
  });
}

export async function adminStats(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return preflight(request);
  if (adminStatus(request) !== 'valid') {
    return json(request, 401, { error: 'unauthorized', message: '管理員金鑰無效。' });
  }
  try {
    if (request.method === 'GET') return await handleGet(request);
    return await handlePost(request, context);
  } catch (err) {
    if (err instanceof BadRequestError) {
      return json(request, 400, { error: err.code, message: err.message });
    }
    context.error('[adminStats] 未預期錯誤', err);
    return json(request, 500, { error: 'internal_error', message: '系統忙碌中，請稍後再試。' });
  }
}

app.http('adminStats', {
  route: 'dashboard-stats',
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: adminStats
});
