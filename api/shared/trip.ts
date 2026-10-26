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
    /** AI 賦予的慢旅人格標籤，例如「🍵 古都老屋駐留者」 */
    traveler_persona: string;
    vibe_description: string;
    svg_theme: SvgTheme;
    flight_card: {
      outbound_hint: string;
      inbound_hint: string;
    };
    /** 使用者選填的抵達時間（例：14:30、下午）；由後端依請求寫入，不是 AI 產生 */
    arrival_time?: string;
    /** 使用者選填的離境/離開時間（例：18:00、晚上）；由後端依請求寫入 */
    departure_time?: string;
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

/** 選填抵達 / 離開時間：最多 20 字，空值不輸出欄位 */
export const TRAVEL_TIME_MAX = 20;

function optionalTimes(summary: Record<string, unknown>): { arrival_time?: string; departure_time?: string } {
  const arrival = str(summary.arrival_time, TRAVEL_TIME_MAX);
  const departure = str(summary.departure_time, TRAVEL_TIME_MAX);
  return { ...(arrival ? { arrival_time: arrival } : {}), ...(departure ? { departure_time: departure } : {}) };
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
      traveler_persona: str(summaryIn.traveler_persona, 30),
      vibe_description: str(summaryIn.vibe_description, 300),
      svg_theme,
      flight_card: {
        outbound_hint: str(flightIn.outbound_hint, 300),
        inbound_hint: str(flightIn.inbound_hint, 300)
      },
      // 只有寬鬆模式（寄信時由前端帶回）才保留；AI 輸出一律以後端收到的請求為準
      ...(opts.lenient ? optionalTimes(summaryIn) : {})
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

/** 結果頁 / 行程信的首末日調整提示（前端 index.html 使用相同文字） */
export function arrivalNote(time: string): string {
  return `首日預計於 ${time} 抵達，已為您調整當日漫步節奏`;
}

export function departureNote(time: string): string {
  return `末日預計於 ${time} 離開，已為您預留散步、採買與前往機場 / 車站的時間`;
}

/* ------------------------------------------------------------------ */
/* 末日時間軸切斷：依離境 / 離開時間刪掉離開之後的時段                         */
/* （前端 index.html 的 departureBucket / applyDepartureCutoff 使用相同規則）  */
/* ------------------------------------------------------------------ */

export type DepartureBucket = 'morning' | 'afternoon' | 'evening';

/**
 * 「09:30」「9點」「下午3點」「3pm」「上午」「晚上」… → 早於 12:00 為 morning、12:00~17:00 為 afternoon、晚於 17:00 為 evening。
 * 無法判斷時回傳 null（維持 AI 原本的安排）。
 */
export function departureBucket(raw: string | undefined): DepartureBucket | null {
  const text = String(raw ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .toLowerCase()
    .trim();
  if (!text) return null;
  const pm = /下午|午後|傍晚|晚上|晚間|夜|pm/.test(text);
  const m = text.match(/(\d{1,2})\s*(?::|點|时|時|h)\s*(\d{1,2})?/) || text.match(/(\d{1,2})\s*(?:am|pm)/) || text.match(/^(\d{1,2})$/);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] !== undefined ? Number(m[2]) || 0 : /\d\s*[點時时]半/.test(text) ? 30 : 0;
    if (pm && hour < 12) hour += 12;
    if (/凌晨|am/.test(text) && hour === 12) hour = 0;
    if (hour <= 24) {
      const t = hour * 60 + minute;
      return t < 12 * 60 ? 'morning' : t <= 17 * 60 ? 'afternoon' : 'evening';
    }
  }
  if (/午前|凌晨|清晨|一早|早上|早晨|上午|morning/.test(text)) return 'morning';
  if (/中午|午後|下午|afternoon|noon/.test(text)) return 'afternoon';
  if (/傍晚|晚上|晚間|夜|evening|night/.test(text)) return 'evening';
  return null;
}

/** 離境時段之後不該出現的 time_slot */
const SLOT_AFTER: Record<DepartureBucket, RegExp | null> = {
  morning: /中午|午後|下午|傍晚|黃昏|晚|夜/,
  afternoon: /傍晚|黃昏|晚|夜/,
  evening: null
};

/**
 * 末日只保留離開之前的時段：上午離境 → 最多 2 個且不得有下午 / 傍晚；下午離境 → 最多 2 個且不得有傍晚。
 * 全部被過濾時保留第一個並改標為「上午」，確保最後一天至少有 1 個行程（前往機場 / 車站）。
 */
export function applyDepartureCutoff(trip: TripPlan): TripPlan {
  const bucket = departureBucket(trip.trip_summary.departure_time);
  const after = bucket ? SLOT_AFTER[bucket] : null;
  const days = trip.daily_itinerary;
  if (!after || !days.length) return trip;
  const last = days[days.length - 1];
  let timeline = last.timeline.filter((t) => !after.test(t.time_slot));
  if (!timeline.length && last.timeline.length) {
    timeline = [{ ...last.timeline[0], time_slot: bucket === 'morning' ? '上午' : '下午' }];
  }
  timeline = timeline.slice(0, 2);
  if (timeline.length === last.timeline.length) return trip;
  return { ...trip, daily_itinerary: [...days.slice(0, -1), { ...last, timeline }] };
}
