/**
 * 贊助方案（Portaly 自動發碼）。App Setting PROMO_MODE 切換：
 *   NORMAL（預設）：終身買斷制 NT$ 90 個人版（LIFE-）/ NT$ 199 旅伴親友團版（GROUP-），
 *                   無總次數上限、每組序號每日 10 次（台灣時間 00:00 重置），見 shared/redeemCodes.ts
 *                   （舊的 SM1 / SM3 / SM5 / SM10 序號照舊依剩餘次數使用）
 *   XMAS         ：🎄 聖誕限時囤票祭 NT$ 199 / 300 / 488（加量不加價）
 * 前端 index.html 的 IS_XMAS_PROMO 需同步切換贊助彈窗文案。
 *
 * AllowSameEmail：
 *   true  ：不限信箱，誰都可以用到次數用完
 *   false ：買家本人（OwnerEmail）可重複使用全部次數；旅伴每個信箱限用 1 次
 */

export type PromoMode = 'NORMAL' | 'XMAS';

export interface SponsorPlan {
  /** 序號前綴（SM3 → SM3-XXXX-YYYY） */
  prefix: string;
  name: string;
  totalUses: number;
  allowSameEmail: boolean;
  campaignTag: 'PORTALY_NORMAL' | 'PORTALY_XMAS' | 'PORTALY_LIFETIME';
  /** 終身買斷：每日上限與可分享的旅伴人數（有這個欄位就不看 totalUses） */
  lifetime?: { dailyLimit: number; groupMaxFriends: number };
}

export const PLANS = {
  LIFE: { prefix: 'LIFE', name: '☕ 個人終身買斷版', totalUses: 1, allowSameEmail: false, campaignTag: 'PORTALY_LIFETIME', lifetime: { dailyLimit: 10, groupMaxFriends: 0 } },
  GROUP: { prefix: 'GROUP', name: '🍱 旅伴親友團買斷版', totalUses: 1, allowSameEmail: false, campaignTag: 'PORTALY_LIFETIME', lifetime: { dailyLimit: 10, groupMaxFriends: 15 } },
  SM1: { prefix: 'SM1', name: '☕ 單次試調體驗', totalUses: 1, allowSameEmail: true, campaignTag: 'PORTALY_NORMAL' },
  XMAS3: { prefix: 'XMAS3', name: '🎄 聖誕雙人福袋', totalUses: 3, allowSameEmail: true, campaignTag: 'PORTALY_XMAS' },
  XMAS7: { prefix: 'XMAS7', name: '🦌 聖誕旅伴加碼包', totalUses: 7, allowSameEmail: false, campaignTag: 'PORTALY_XMAS' },
  XMAS14: { prefix: 'XMAS14', name: '🎅 2027 全年慢旅年票', totalUses: 14, allowSameEmail: false, campaignTag: 'PORTALY_XMAS' }
} as const satisfies Record<string, SponsorPlan>;

export function promoMode(): PromoMode {
  return (process.env.PROMO_MODE || '').trim().toUpperCase() === 'XMAS' ? 'XMAS' : 'NORMAL';
}

/**
 * 依贊助金額決定方案：
 *   NORMAL：>= 199 GROUP（旅伴親友團買斷）、其他 LIFE（個人終身買斷）
 *   XMAS  ：>= 488 XMAS14、>= 300 XMAS7、>= 199 XMAS3、其他 SM1
 * 金額解析失敗或低於 90（例如 Portaly 調價、通知信格式改變）也照常發個人買斷碼，確保不漏單。
 */
export function planForAmount(amount: number, mode: PromoMode = promoMode()): SponsorPlan {
  if (mode === 'XMAS') {
    if (amount >= 488) return PLANS.XMAS14;
    if (amount >= 300) return PLANS.XMAS7;
    if (amount >= 199) return PLANS.XMAS3;
    return PLANS.SM1;
  }
  return amount >= 199 ? PLANS.GROUP : PLANS.LIFE;
}
