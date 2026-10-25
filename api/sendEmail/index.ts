import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { BadRequestError, envInt, json, normalizeEmail, preflight, readJsonBody } from '../shared/http';
import { SLOW_TRAVEL_NOTE_BODY, SLOW_TRAVEL_NOTE_TITLE, escapeHtml, sendMail } from '../shared/mailer';
import { EMAIL_COUNTER, decrementCounter, taipeiDateKey, tryIncrementCounter } from '../shared/storage';
import { TripPlan, TripValidationError, googleMapsUrl, sanitizeTrip } from '../shared/trip';

/**
 * POST /api/send-email
 * Body: { email, destination, itinerary_data }
 *
 * 防濫用：
 * - 同一收件人 60 秒內只能寄一次（單一執行個體記憶體節流，對應前端 60 秒鎖定）
 * - 全站每日寄信上限 EMAIL_DAILY_CAP（預設 400，Gmail 個人帳號每日約 500 封），記錄於 DailyUsage(PartitionKey='EmailDaily')
 * - 行程內容一律經過 sanitizeTrip 清洗與 HTML 轉義
 */

const COUNTER_KIND = EMAIL_COUNTER;
const RECIPIENT_COOLDOWN_MS = 60 * 1000;
const recentRecipients = new Map<string, number>();

function checkCooldown(email: string): number {
  const now = Date.now();
  for (const [k, t] of recentRecipients) {
    if (now - t > RECIPIENT_COOLDOWN_MS) recentRecipients.delete(k);
  }
  const last = recentRecipients.get(email);
  return last ? Math.ceil((RECIPIENT_COOLDOWN_MS - (now - last)) / 1000) : 0;
}

/* ------------------------------------------------------------------ */
/* HTML 信件（表格排版 + inline style，相容 Gmail / Outlook / Apple Mail）  */
/* ------------------------------------------------------------------ */

const C = {
  bg: '#FBF9F5',
  card: '#FFFFFF',
  subtle: '#F3EFE6',
  text: '#2C3531',
  muted: '#6E7873',
  sage: '#5B7B6A',
  sageDark: '#435E4F',
  sageLight: '#E6EFEA',
  coral: '#E07A5F',
  border: '#E6E1D6'
};

const PORTALY_URL = () => process.env.PORTALY_URL || 'https://portaly.cc/samya_traveler';
const APP_URL = () => process.env.SLOWMATE_APP_URL || 'https://samya-traveler.github.io/slowmate/';

const ctaText = (portalyUrl: string) =>
  `💌 喜歡這份慢旅行程嗎？歡迎直接轉寄給旅伴一起討論！出發前若行程有變動，買杯 NT$88 的咖啡支持獨立開發（ ${portalyUrl} ），就能在 1~3 分鐘內收到新序號重新微調行程喔！`;

/** 轉寄給旅伴 + 回訪 / 贊助鉤子（放在頁尾上方） */
function ctaBlock(): string {
  const btn = (href: string, label: string, bg: string, fg: string, border: string) =>
    `<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;margin:4px 4px;padding:10px 18px;border-radius:12px;background:${bg};color:${fg};border:1px solid ${border};text-decoration:none;font-weight:700;font-size:14px;">${label}</a>`;
  return `
        <tr><td style="padding:0 16px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF6E9;border:1px solid #F2D7A9;border-radius:16px;">
            <tr><td style="padding:18px 18px 14px;font-size:14px;line-height:1.8;color:${C.text};">
              ${escapeHtml(ctaText(PORTALY_URL())).replace(
                escapeHtml(PORTALY_URL()),
                `<a href="${escapeHtml(PORTALY_URL())}" target="_blank" style="color:${C.coral};font-weight:700;text-decoration:underline;">${escapeHtml(PORTALY_URL())}</a>`
              )}
            </td></tr>
            <tr><td align="center" style="padding:0 14px 18px;">
              ${btn(PORTALY_URL(), '❤️ 贊助獲得新序號', C.coral, '#FFFFFF', C.coral)}
              ${btn(APP_URL(), '🌿 回到 SlowMate 規劃', '#FFFFFF', C.sageDark, C.sage)}
            </td></tr>
          </table>
        </td></tr>`;
}

function section(title: string, inner: string): string {
  if (!inner.trim()) return '';
  return `
  <tr><td style="padding:0 16px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.border};border-radius:16px;">
      <tr><td style="padding:20px 20px 6px;font-family:'Noto Serif TC',Georgia,serif;font-size:18px;font-weight:700;color:${C.text};">${title}</td></tr>
      <tr><td style="padding:6px 20px 20px;">${inner}</td></tr>
    </table>
  </td></tr>`;
}

function renderHtml(trip: TripPlan): string {
  const s = trip.trip_summary;
  const prep = trip.pre_trip_prep;
  const dest = s.destination;

  const flight = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="background:${C.bg};border-left:4px solid ${C.sage};border-radius:10px;padding:12px 14px;">
        <div style="font-size:12px;font-weight:700;color:${C.sageDark};letter-spacing:1px;">OUTBOUND 去程建議</div>
        <div style="font-size:14px;color:${C.muted};line-height:1.6;">${escapeHtml(s.flight_card.outbound_hint || '建議提早抵達機場辦理登機。')}</div>
      </td></tr>
      <tr><td style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr>
      <tr><td style="background:${C.bg};border-left:4px solid ${C.sage};border-radius:10px;padding:12px 14px;">
        <div style="font-size:12px;font-weight:700;color:${C.sageDark};letter-spacing:1px;">INBOUND 回程提醒</div>
        <div style="font-size:14px;color:${C.muted};line-height:1.6;">${escapeHtml(s.flight_card.inbound_hint || '回程預留充裕時間通關。')}</div>
      </td></tr>
    </table>`;

  const passes = prep.transport_passes
    .map(
      (p) => `
      <div style="padding:10px 0;border-bottom:1px dashed ${C.border};">
        <div style="font-size:15px;font-weight:700;color:${C.text};">🚆 ${escapeHtml(p.name)}
          <span style="display:inline-block;font-size:12px;font-weight:600;background:#FFF3E0;color:#E65100;border-radius:99px;padding:2px 8px;margin-left:4px;">${escapeHtml(p.buy_timing || '行前購買')}</span>
        </div>
        <div style="font-size:14px;color:${C.muted};line-height:1.6;">${escapeHtml(p.description)}</div>
      </div>`
    )
    .join('');

  const reservations = prep.advance_reservations
    .map(
      (r) => `
      <div style="padding:10px 0;border-bottom:1px dashed ${C.border};">
        <div style="font-size:15px;font-weight:700;color:${C.text};">📌 ${escapeHtml(r.target)}
          <span style="display:inline-block;font-size:12px;font-weight:600;background:#FCE8E6;color:#C5221F;border-radius:99px;padding:2px 8px;margin-left:4px;">${escapeHtml(r.deadline_note)}</span>
        </div>
        <div style="font-size:14px;color:${C.muted};line-height:1.6;">${escapeHtml(r.tips)}</div>
      </div>`
    )
    .join('');

  const days = trip.daily_itinerary
    .map((d) => {
      const items = d.timeline
        .map(
          (t) => `
        <tr>
          <td width="14" valign="top" style="padding-top:6px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${C.sage};"></div>
          </td>
          <td style="padding:0 0 16px 8px;">
            <div style="font-size:12px;color:${C.muted};font-weight:700;">
              ${escapeHtml(t.time_slot)}
              <span style="display:inline-block;background:${escapeHtml(t.transport_tag.color_code)};color:#fff;border-radius:6px;padding:1px 7px;font-size:11px;margin-left:4px;">${escapeHtml(t.transport_tag.type)}</span>
              ${t.is_must_visit ? `<span style="display:inline-block;background:${C.coral};color:#fff;border-radius:6px;padding:1px 7px;font-size:11px;margin-left:4px;">★ 必去</span>` : ''}
            </div>
            <div style="font-size:15px;font-weight:700;color:${C.text};margin:2px 0;">
              ${escapeHtml(t.title)}
              <a href="${escapeHtml(googleMapsUrl(t.title, dest))}" target="_blank" style="font-size:12px;font-weight:600;color:${C.sageDark};background:${C.sageLight};border-radius:99px;padding:2px 8px;text-decoration:none;margin-left:4px;white-space:nowrap;">📍 導航</a>
            </div>
            <div style="font-size:14px;color:${C.muted};line-height:1.6;">${escapeHtml(t.description)}</div>
          </td>
        </tr>`
        )
        .join('');
      const stay =
        d.stay_info.area_recommendation || d.stay_info.hotel_vibe
          ? `<div style="background:#F7F5F0;border:1px solid ${C.border};border-radius:10px;padding:10px 12px;font-size:13px;color:${C.text};">
               <strong>🛏️ 住宿區域建議：${escapeHtml(d.stay_info.area_recommendation)}</strong><br>
               <span style="color:${C.muted};">${escapeHtml(d.stay_info.hotel_vibe)}</span>
             </div>`
          : '';
      return `
      <div style="margin-bottom:22px;">
        <div style="background:${C.subtle};border-radius:10px;padding:10px 14px;margin-bottom:12px;">
          <div style="font-size:12px;color:${C.muted};">Day ${d.day_index}${d.date ? `｜${escapeHtml(d.date)}` : ''}</div>
          <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:16px;font-weight:700;color:${C.sageDark};">${escapeHtml(d.day_title)}</div>
        </div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
        ${stay}
      </div>`;
    })
    .join('');

  const todos = prep.todo_checklist
    .map((t) => `<div style="padding:6px 0;font-size:14px;color:${C.text};border-bottom:1px solid ${C.subtle};">☐ ${escapeHtml(t)}</div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${escapeHtml(s.theme_title)}</title>
<style>
  @media only screen and (max-width: 620px) {
    .sm-wrap { width: 100% !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:'Noto Sans TC',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei',sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(s.vibe_description)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
    <tr><td align="center" style="padding:24px 0;">
      <table role="presentation" class="sm-wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;">
        <tr><td style="padding:0 16px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(180deg,#EAF1EC 0%,#FBF9F5 100%);background-color:#EAF1EC;border:1px solid ${C.border};border-radius:20px;">
            <tr><td align="center" style="padding:26px 20px;">
              <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:14px;letter-spacing:2px;color:${C.sageDark};font-weight:700;">SlowMate 慢旅伴 · AI 慢旅行程規劃師</div>
              <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:22px;font-weight:700;color:${C.text};margin:10px 0 8px;line-height:1.4;">${escapeHtml(s.theme_title)}</div>
              ${s.traveler_persona ? `<div style="display:inline-block;margin:0 0 10px;padding:5px 14px;border-radius:999px;background:#FFFFFF;border:1px solid ${C.border};font-size:13px;font-weight:700;color:${C.sageDark};">慢旅人格｜${escapeHtml(s.traveler_persona)}</div>` : ''}
              <div style="font-size:14px;color:${C.muted};line-height:1.7;">${escapeHtml(s.vibe_description)}</div>
            </td></tr>
          </table>
        </td></tr>
        ${section('✈️ 航班與進出城建議', flight)}
        ${section('🎫 推薦交通 Pass 與事前預約', passes + reservations)}
        ${section('🌿 每日慢旅時間軸', days)}
        ${section('☑️ 行前準備待辦清單', todos)}
        <tr><td style="padding:0 16px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F6F2;border:1px dashed #A9C4B3;border-radius:16px;">
            <tr><td style="padding:16px 18px;font-size:13px;line-height:1.8;color:${C.text};">
              <strong style="color:${C.sageDark};">${escapeHtml(SLOW_TRAVEL_NOTE_TITLE)}</strong><br>
              ${escapeHtml(SLOW_TRAVEL_NOTE_BODY)}
            </td></tr>
          </table>
        </td></tr>
        ${ctaBlock()}
        <tr><td align="center" style="padding:8px 16px 24px;font-size:12px;color:${C.muted};line-height:1.7;">
          Curated Slow Travel by <a href="https://samya-traveler.github.io/" style="color:${C.sageDark};text-decoration:none;font-weight:600;">@samya_traveler</a> ·
          <a href="https://samya-traveler.github.io/slowmate/" style="color:${C.sageDark};text-decoration:none;font-weight:600;">SlowMate 慢旅伴</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderText(trip: TripPlan): string {
  const s = trip.trip_summary;
  const prep = trip.pre_trip_prep;
  const lines: string[] = [
    `🌿 【${s.theme_title || s.destination}】慢旅行程表`,
    ...(s.traveler_persona ? [`慢旅人格：${s.traveler_persona}`] : []),
    s.vibe_description,
    '----------------------------------------',
    `✈️ 去程：${s.flight_card.outbound_hint}`,
    `✈️ 回程：${s.flight_card.inbound_hint}`,
    ''
  ];
  if (prep.transport_passes.length) {
    lines.push('🎫 推薦交通券：');
    prep.transport_passes.forEach((p) => lines.push(`• ${p.name}（${p.buy_timing}）：${p.description}`));
    lines.push('');
  }
  if (prep.advance_reservations.length) {
    lines.push('📌 需提前預約：');
    prep.advance_reservations.forEach((r) => lines.push(`• ${r.target} [${r.deadline_note}]：${r.tips}`));
    lines.push('');
  }
  trip.daily_itinerary.forEach((d) => {
    lines.push(`📅 Day ${d.day_index}${d.date ? ` (${d.date})` : ''}｜${d.day_title}`);
    d.timeline.forEach((t) => {
      const must = t.is_must_visit ? '[★必去] ' : '';
      lines.push(`  - 【${t.time_slot}｜${t.transport_tag.type}】${must}${t.title}：${t.description}`);
      lines.push(`    📍 ${googleMapsUrl(t.title, s.destination)}`);
    });
    if (d.stay_info.area_recommendation) {
      lines.push(`  🛏️ 住宿建議：${d.stay_info.area_recommendation}（${d.stay_info.hotel_vibe}）`);
    }
    lines.push('');
  });
  if (prep.todo_checklist.length) {
    lines.push('☑️ 行前待辦：');
    prep.todo_checklist.forEach((t) => lines.push(`☐ ${t}`));
    lines.push('');
  }
  lines.push(SLOW_TRAVEL_NOTE_TITLE, SLOW_TRAVEL_NOTE_BODY, '');
  lines.push(ctaText(PORTALY_URL()), `• 回到 SlowMate 規劃：${APP_URL()}`, '');
  lines.push('— SlowMate 慢旅伴｜AI 慢旅行程規劃師 · https://samya-traveler.github.io/slowmate/');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Handler                                                              */
/* ------------------------------------------------------------------ */

interface SendEmailBody {
  email?: unknown;
  destination?: unknown;
  itinerary_data?: unknown;
}

export async function sendEmail(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method === 'OPTIONS') return preflight(request);

  try {
    const body = await readJsonBody<SendEmailBody>(request, 256 * 1024);
    const email = normalizeEmail(body.email);

    let trip: TripPlan;
    try {
      trip = sanitizeTrip(body.itinerary_data, { lenient: true });
    } catch (err) {
      if (err instanceof TripValidationError) throw new BadRequestError(`行程資料格式不正確：${err.message}`);
      throw err;
    }
    const destination = String(body.destination ?? '').trim().slice(0, 60) || trip.trip_summary.destination;

    const wait = checkCooldown(email);
    if (wait > 0) {
      return json(request, 429, { error: 'email_cooldown', message: `剛剛已寄出行程，請 ${wait} 秒後再試。`, retry_after: wait });
    }

    const dateKey = taipeiDateKey();
    const quota = await tryIncrementCounter(COUNTER_KIND, dateKey, envInt('EMAIL_DAILY_CAP', 400));
    if (!quota.ok) {
      return json(request, 429, {
        error: 'email_daily_cap',
        message: '今日寄信服務額度已滿，請先使用「複製純文字行程」保存，明天再寄送 🌿'
      });
    }

    recentRecipients.set(email, Date.now());
    try {
      const id = await sendMail({
        to: email,
        subject: `🌿 你的【${destination}】慢旅行程表｜${trip.trip_summary.theme_title}`.slice(0, 150),
        html: renderHtml(trip),
        text: renderText(trip)
      });
      context.log(`[sendEmail] sent id=${id}`);
      return json(request, 200, {
        ok: true,
        id,
        message: '行程已寄出！若未收到，請檢查垃圾郵件匣或促銷分頁。'
      });
    } catch (err) {
      recentRecipients.delete(email);
      try {
        await decrementCounter(COUNTER_KIND, dateKey);
      } catch (rollbackErr) {
        context.error('[sendEmail] 寄信額度回滾失敗', rollbackErr);
      }
      context.error('[sendEmail] Gmail 寄信失敗', err);
      return json(request, 502, { error: 'email_failed', message: '寄信服務暫時忙碌，請先使用「複製純文字行程」保存。' });
    }
  } catch (err) {
    if (err instanceof BadRequestError) {
      return json(request, 400, { error: err.code, message: err.message });
    }
    context.error('[sendEmail] 未預期錯誤', err);
    return json(request, 500, { error: 'internal_error', message: '系統忙碌中，請稍後再試。' });
  }
}

app.http('sendEmail', {
  route: 'send-email',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: sendEmail
});
