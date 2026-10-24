/**
 * 前後端共用的 AI 行程 Data Contract。
 * planTrip 用它驗證 Azure OpenAI 的輸出；sendEmail 用它清洗前端送來的行程。
 */

export const SVG_THEMES = ['kyoto', 'tokyo', 'nature_mountain', 'ocean_beach', 'default_train'] as const;
export type SvgTheme = (typeof SVG_THEMES)[number];

export interface TransportTag {
  type: string;
  color_code: string;
}

export interface TimelineItem {
  time_slot: string;
  title: string;
  is_must_visit: boolean;
  transport_tag: TransportTag;
  description: string;
}

export interface DayPlan {
  day_index: number;
  date: string;
  day_title: string;
  timeline: TimelineItem[];
  stay_info: {
    area_recommendation: string;
    hotel_vibe: string;
  };
}

export interface TripPlan {
  trip_summary: {
    destination: string;
    theme_title: string;
    vibe_description: string;
    svg_theme: SvgTheme;
    flight_card: {
      outbound_hint: string;
      inbound_hint: string;
    };
  };
  pre_trip_prep: {
    transport_passes: { name: string; description: string; buy_timing: string }[];
    advance_reservations: { target: string; deadline_note: string; tips: string }[];
    todo_checklist: string[];
  };
  daily_itinerary: DayPlan[];
}

export const MAX_TRIP_DAYS = 14;

export class TripValidationError extends Error {}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max: number, fallback = ''): string {
  if (typeof v !== 'string' && typeof v !== 'number') return fallback;
  // 移除控制字元，保留換行
  const s = String(v).replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  return s ? s.slice(0, max) : fallback;
}

function arr(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

export interface SanitizeOptions {
  /** 嚴格模式：用於驗證 AI 輸出，天數必須完全符合 */
  expectedDates?: string[];
  /** 寬鬆模式：用於寄信 */
  lenient?: boolean;
}

/**
 * 驗證並清洗行程物件。所有字串都會截斷長度、顏色只接受 HEX、svg_theme 只接受白名單。
 * 嚴格模式下，day_index 與 date 會以後端計算的日期覆寫，確保日期正確。
 */
export function sanitizeTrip(input: unknown, opts: SanitizeOptions = {}): TripPlan {
  if (!isObj(input)) throw new TripValidationError('行程資料必須是 JSON 物件');
  const summaryIn = input.trip_summary;
  const prepIn = isObj(input.pre_trip_prep) ? input.pre_trip_prep : {};
  const daysIn = input.daily_itinerary;
  if (!isObj(summaryIn)) throw new TripValidationError('缺少 trip_summary');
  if (!Array.isArray(daysIn) || daysIn.length === 0) throw new TripValidationError('缺少 daily_itinerary');

  const expected = opts.expectedDates;
  if (expected && daysIn.length < expected.length) {
    throw new TripValidationError(`daily_itinerary 天數不足（需要 ${expected.length} 天，收到 ${daysIn.length} 天）`);
  }
  if (!expected && daysIn.length > MAX_TRIP_DAYS) {
    throw new TripValidationError(`行程最多 ${MAX_TRIP_DAYS} 天`);
  }

  const flightIn = isObj(summaryIn.flight_card) ? summaryIn.flight_card : {};
  const themeRaw = str(summaryIn.svg_theme, 40);
  const svg_theme: SvgTheme = (SVG_THEMES as readonly string[]).includes(themeRaw) ? (themeRaw as SvgTheme) : 'default_train';

  const destination = str(summaryIn.destination, 80);
  if (!destination && !opts.lenient) throw new TripValidationError('缺少 trip_summary.destination');

  const days = (expected ? daysIn.slice(0, expected.length) : daysIn).map((d, idx): DayPlan => {
    const day = isObj(d) ? d : {};
    const timelineIn = arr(day.timeline, 6);
    if (!opts.lenient && timelineIn.length === 0) {
      throw new TripValidationError(`第 ${idx + 1} 天缺少 timeline`);
    }
    const stay = isObj(day.stay_info) ? day.stay_info : {};
    const rawDate = str(day.date, 10);
    return {
      day_index: expected ? idx + 1 : Number.isInteger(day.day_index) ? (day.day_index as number) : idx + 1,
      date: expected ? expected[idx] : DATE_RE.test(rawDate) ? rawDate : '',
      day_title: str(day.day_title, 120, `Day ${idx + 1}`),
      timeline: timelineIn.map((t): TimelineItem => {
        const item = isObj(t) ? t : {};
        const tag = isObj(item.transport_tag) ? item.transport_tag : {};
        const color = str(tag.color_code, 7);
        return {
          time_slot: str(item.time_slot, 10, '行程'),
          title: str(item.title, 120, '自由散策'),
          is_must_visit: item.is_must_visit === true,
          transport_tag: {
            type: str(tag.type, 20, '移動'),
            color_code: HEX_COLOR_RE.test(color) ? color : '#5B7B6A'
          },
          description: str(item.description, 600)
        };
      }),
      stay_info: {
        area_recommendation: str(stay.area_recommendation, 120),
        hotel_vibe: str(stay.hotel_vibe, 300)
      }
    };
  });

  return {
    trip_summary: {
      destination: destination || '慢旅',
      theme_title: str(summaryIn.theme_title, 120, `${destination || '慢旅'}・慢旅日誌`),
      vibe_description: str(summaryIn.vibe_description, 300),
      svg_theme,
      flight_card: {
        outbound_hint: str(flightIn.outbound_hint, 300),
        inbound_hint: str(flightIn.inbound_hint, 300)
      }
    },
    pre_trip_prep: {
      transport_passes: arr(prepIn.transport_passes, 8).map((p) => {
        const o = isObj(p) ? p : {};
        return { name: str(o.name, 120), description: str(o.description, 300), buy_timing: str(o.buy_timing, 80) };
      }).filter((p) => p.name),
      advance_reservations: arr(prepIn.advance_reservations, 10).map((r) => {
        const o = isObj(r) ? r : {};
        return { target: str(o.target, 120), deadline_note: str(o.deadline_note, 80), tips: str(o.tips, 300) };
      }).filter((r) => r.target),
      todo_checklist: arr(prepIn.todo_checklist, 20).map((t) => str(t, 160)).filter(Boolean)
    },
    daily_itinerary: days
  };
}

/** 依開始/結束日期（YYYY-MM-DD）列出每一天。日期無效回傳 null。 */
export function listTripDates(start: string, end: string): string[] | null {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) return null;
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  // 擋掉 2026-02-31 之類被自動進位的日期
  if (new Date(s).toISOString().slice(0, 10) !== start || new Date(e).toISOString().slice(0, 10) !== end) return null;
  const days = Math.round((e - s) / 86400000) + 1;
  if (days < 1) return [];
  const out: string[] = [];
  for (let i = 0; i < Math.min(days, MAX_TRIP_DAYS + 1); i++) {
    out.push(new Date(s + i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

export function googleMapsUrl(title: string, destination: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${title} ${destination}`)}`;
}
