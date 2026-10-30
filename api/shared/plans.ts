/**
 * 贊助方案（Portaly 自動發碼）。App Setting PROMO_MODE 切換：
 *   NORMAL（預設）：NT$ 69 / 99 / 299 常態三階定價（SM1 / SM3 / SM10）
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
  campaignTag: 'PORTALY_NORMAL' | 'PORTALY_XMAS';
}

export const PLANS = {
  SM1: { prefix: 'SM1', name: '☕ 單次試調體驗', totalUses: 1, allowSameEmail: true, campaignTag: 'PORTALY_NORMAL' },
  SM3: { prefix: 'SM3', name: '🌿 單趟旅程微調包', totalUses: 3, allowSameEmail: true, campaignTag: 'PORTALY_NORMAL' },
  SM10: { prefix: 'SM10', name: '🍱 慢旅玩家同樂包', totalUses: 10, allowSameEmail: false, campaignTag: 'PORTALY_NORMAL' },
  XMAS3: { prefix: 'XMAS3', name: '🎄 聖誕雙人福袋', totalUses: 3, allowSameEmail: true, campaignTag: 'PORTALY_XMAS' },
  XMAS7: { prefix: 'XMAS7', name: '🦌 聖誕旅伴加碼包', totalUses: 7, allowSameEmail: false, campaignTag: 'PORTALY_XMAS' },
  XMAS14: { prefix: 'XMAS14', name: '🎅 2027 全年慢旅年票', totalUses: 14, allowSameEmail: false, campaignTag: 'PORTALY_XMAS' }
} as const satisfies Record<string, SponsorPlan>;

export function promoMode(): PromoMode {
  return (process.env.PROMO_MODE || '').trim().toUpperCase() === 'XMAS' ? 'XMAS' : 'NORMAL';
}

/**
 * 依贊助金額決定方案：
 *   NORMAL：>= 299 SM10（10 次）、>= 99 SM3（3 次）、其他 SM1（1 次）
 *   XMAS  ：>= 488 XMAS14、>= 300 XMAS7、>= 199 XMAS3、其他 SM1
 * 金額解析失敗或低於 69（例如 Portaly 調價、通知信格式改變）也照常發 1 次碼，確保不漏單。
 */
export function planForAmount(amount: number, mode: PromoMode = promoMode()): SponsorPlan {
  if (mode === 'XMAS') {
    if (amount >= 488) return PLANS.XMAS14;
    if (amount >= 300) return PLANS.XMAS7;
    if (amount >= 199) return PLANS.XMAS3;
    return PLANS.SM1;
  }
  if (amount >= 299) return PLANS.SM10;
  if (amount >= 99) return PLANS.SM3;
  return PLANS.SM1;
}
