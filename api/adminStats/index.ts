import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { BadRequestError, adminStatus, envInt, json, preflight, readJsonBody } from '../shared/http';
import { AdminCodeInputError, AdminGenerateInput, adminGenerateCodes, listAllCodes } from '../shared/redeemCodes';
import {
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
 *     users: 已完成首次免費體驗的使用者 [{ email, used_at, destination? }]（used_at 倒序；destination 為最近一次規劃的目的地）,
 *     total_codes, campaigns: 各 campaign_tag 核銷統計, top_codes: 序號核銷排行榜 }
 *
 * POST /api/dashboard-stats   產生行銷序號（與 POST /api/generateCode 的 mode: batch / custom 相同）
 *   批次產碼：{ mode: 'batch', count: 20, max_uses: 10, prefix: 'GIFT10-', allow_same_email: true, campaign_tag: 'REELS_BIRTH' }
 *   指定公用碼：{ mode: 'custom', custom_code: 'NOV-VIP', max_uses: 50, allow_same_email: false, campaign_tag: 'NOV_GIFT' }
 *     代碼已存在時改為更新次數與規則（已用掉的次數照算）
 *   201 { mode, codes: [{ code, magic_link, max_uses, remaining_uses, allow_same_email, campaign_tag, updated? }] }
 *
 *   401 { error: 'unauthorized' }  未帶或帶錯金鑰
 */

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

  // 用戶數 + 已完成首次免費體驗的名單（供戰情室匯出 Email 寄發問卷，依體驗時間倒序）
  const profiles = await getTable(TABLES.UserProfiles);
  let totalUsers = 0;
  const users: { email: string; used_at: string; destination?: string }[] = [];
  for await (const e of profiles.listEntities<{ free_quota_used?: boolean; email?: string; used_at?: string; last_destination?: string }>({
    queryOptions: { filter: odata`PartitionKey eq ${PROFILE_PK}`, select: ['RowKey', 'free_quota_used', 'email', 'used_at', 'last_destination'] }
  })) {
    totalUsers++;
    if (e.free_quota_used !== true) continue;
    users.push({
      email: e.email || decodeURIComponent(String(e.rowKey)),
      used_at: e.used_at || '',
      ...(e.last_destination ? { destination: e.last_destination } : {})
    });
  }
  users.sort((a, b) => b.used_at.localeCompare(a.used_at));

  // 序號：各活動核銷統計 + 排行榜（新舊 PartitionKey 都列）
  const campaigns = new Map<string, CampaignStat>();
  const codes: { code: string; campaign_tag: string; used_count: number; max_uses: number; remaining_uses: number; allow_same_email: boolean; owner: boolean; status: string; created_at: string }[] = [];
  for await (const v of listAllCodes()) {
    const used = v.totalUses - v.remainingUses;
    const stat = campaigns.get(v.campaignTag) ?? { campaign_tag: v.campaignTag, codes: 0, capacity: 0, used: 0, exhausted: 0 };
    stat.codes++;
    stat.capacity += v.totalUses;
    stat.used += used;
    if (v.remainingUses <= 0) stat.exhausted++;
    campaigns.set(v.campaignTag, stat);
    codes.push({
      code: v.code,
      campaign_tag: v.campaignTag,
      used_count: used,
      max_uses: v.totalUses,
      remaining_uses: v.remainingUses,
      allow_same_email: v.allowSameEmail,
      owner: !!v.ownerEmail,
      status: v.remainingUses <= 0 ? 'exhausted' : v.pending.length ? 'processing' : 'unused',
      created_at: v.createdAt
    });
  }
  codes.sort((a, b) => b.used_count - a.used_count || b.created_at.localeCompare(a.created_at));

  return json(request, 200, {
    date_key: dateKey,
    timezone: 'Asia/Taipei',
    today: { ...usage, free_limit: free, vip_limit: vip, ...poolRemaining(usage) },
    trend,
    total_users: totalUsers,
    free_trial_users: users.length,
    users,
    emails_sent_today: await readCounter(EMAIL_COUNTER, dateKey),
    email_daily_cap: envInt('EMAIL_DAILY_CAP', 400),
    total_codes: codes.length,
    campaigns: [...campaigns.values()].sort((a, b) => b.used - a.used || b.codes - a.codes),
    top_codes: codes.slice(0, TOP_CODES)
  });
}

/** 戰情室產碼：與 POST /api/generateCode（mode: batch / custom）共用同一套邏輯 */
async function handlePost(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const body = await readJsonBody<AdminGenerateInput>(request, 4 * 1024);
  const result = await adminGenerateCodes(body);
  context.log(`[adminStats] ${result.mode}: ${result.codes.length} code(s) campaign=${result.codes[0]?.campaign_tag}`);
  return json(request, 201, result);
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
    if (err instanceof BadRequestError || err instanceof AdminCodeInputError) {
      return json(request, 400, { error: err instanceof BadRequestError ? err.code : 'invalid_input', message: err.message });
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
