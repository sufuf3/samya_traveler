/**
 * 贊助方案（Portaly 自動發碼）。App Setting PROMO_MODE 切換：
 *   NORMAL（預設）：NT$ 88 / 300 / 488 常態三層定價
 *   XMAS         ：🎄 聖誕限時囤票祭 NT$ 199 / 300 / 488（加量不加價）
 * 前端 index.html 的 IS_XMAS_PROMO 需同步切換贊助彈窗文案。
 *
 * AllowSameEmail：
 *   true  ：不限信箱，誰都可以用到次數用完
 *   false ：買家本人（OwnerEmail）可重複使用全部次數；旅伴每個信箱限用 1 次
 */

export type PromoMode = 'NORMAL' | 'XMAS';

export interface SponsorPlan {
  /** 序號前綴（SM5 → SM5-XXXX-YYYY） */
  prefix: string;
  name: string;
  totalUses: number;
  allowSameEmail: boolean;
  campaignTag: 'PORTALY_NORMAL' | 'PORTALY_XMAS';
}

export const PLANS = {
  SM1: { prefix: 'SM1', name: '☕ 單人微調體驗', totalUses: 1, allowSameEmail: true, campaignTag: 'PORTALY_NORMAL' },
  SM5: { prefix: 'SM5', name: '🌿 旅伴同樂包', totalUses: 5, allowSameEmail: false, campaignTag: 'PORTALY_NORMAL' },
  SM10: { prefix: 'SM10', name: '✨ 慢旅玩家全票', totalUses: 10, allowSameEmail: false, campaignTag: 'PORTALY_NORMAL' },
  XMAS3: { prefix: 'XMAS3', name: '🎄 聖誕雙人福袋', totalUses: 3, allowSameEmail: true, campaignTag: 'PORTALY_XMAS' },
  XMAS7: { prefix: 'XMAS7', name: '🦌 聖誕旅伴加碼包', totalUses: 7, allowSameEmail: false, campaignTag: 'PORTALY_XMAS' },
  XMAS14: { prefix: 'XMAS14', name: '🎅 2027 全年慢旅年票', totalUses: 14, allowSameEmail: false, campaignTag: 'PORTALY_XMAS' }
} as const satisfies Record<string, SponsorPlan>;

export function promoMode(): PromoMode {
  return (process.env.PROMO_MODE || '').trim().toUpperCase() === 'XMAS' ? 'XMAS' : 'NORMAL';
}

/**
 * 依贊助金額決定方案：>= 488、>= 300、>= 199（僅聖誕模式）、其他一律單次碼。
 * 金額解析失敗或低於 88（例如 Portaly 調價、通知信格式改變）也照常發 1 次碼，確保不漏單。
 */
export function planForAmount(amount: number, mode: PromoMode = promoMode()): SponsorPlan {
  const xmas = mode === 'XMAS';
  if (amount >= 488) return xmas ? PLANS.XMAS14 : PLANS.SM10;
  if (amount >= 300) return xmas ? PLANS.XMAS7 : PLANS.SM5;
  if (amount >= 199 && xmas) return PLANS.XMAS3;
  return PLANS.SM1;
}
