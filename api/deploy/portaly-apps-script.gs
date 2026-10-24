/**
 * SlowMate 慢旅伴 — Portaly 贊助自動發碼（Google Apps Script）
 *
 * 安裝在收 Portaly 訂單通知的 Gmail（littlebear.samya@gmail.com）：
 *   1. 到 https://script.google.com 以 littlebear.samya@gmail.com 登入 → 新增專案，貼上本檔全部內容。
 *   2. 左側「專案設定」→「指令碼屬性」新增：
 *        GENERATE_CODE_SECRET = （Azure Portal → slowmate-api → Environment variables 裡的同名值）
 *   3. 上方函式選單選 setup → 執行 → 依指示授權（Gmail、寄信與外部連線）。
 *      setup 會建立「每 1 分鐘」的即時檢查與「每 6 小時」的補漏檢查，並先處理一次近 7 天的訂單。
 *
 * 運作方式：
 *   - 每 1 分鐘（Apps Script 觸發器的最短間隔）搜尋近 1 天 from:service@portaly.cc 主旨「您有一筆新的訂單」的信件；
 *     已全部處理過的對話會直接略過，不讀取內容，因此每次執行通常不到 1 秒。
 *   - 每 6 小時補漏掃描近 7 天，涵蓋 Gmail / Azure 暫時故障的期間。
 *   - 逐封處理（同主旨被 Gmail 串成同一個對話也不會漏）：解析「訂單編號」、買家 Email、金額
 *     → POST /api/generateCode（order_id 冪等：同一筆訂單永遠只發一組序號）。
 *   - 序號信由 Function 透過 Gmail 寄出；若 Function 寄信失敗，本腳本會改用 GmailApp 直接寄出同樣的序號信。
 *   - 成功：記錄為已處理，並在對話加上標籤「SlowMate/已發碼」。
 *   - 解析不到買家 Email、API 回 4xx、或序號信兩條路都寄不出去：寄提醒信給自己，標籤「SlowMate/需人工處理」。
 *   - API 回 5xx / 429 或連線失敗：下一輪（1 分鐘後）自動重試。
 *
 * 除錯：
 *   - debugLatestOrderEmail：把最新一封 Portaly 訂單信的純文字內容與解析結果印在「執行記錄」。
 *   - dryRun：只解析不呼叫 API。
 */

const CONFIG = {
  API_URL: 'https://slowmate-api.azurewebsites.net/api/generateCode',
  BASE_QUERY: 'from:service@portaly.cc subject:"您有一筆新的訂單"',
  FAST_WINDOW: 'newer_than:1d',   // 每 1 分鐘
  CATCHUP_WINDOW: 'newer_than:7d', // 每 6 小時
  APP_URL: 'https://samya-traveler.github.io/slowmate/',
  OWNER_EMAIL: 'littlebear.samya@gmail.com',
  // 這些信箱出現在信件中時不會被當成買家
  IGNORE_EMAILS: ['service@portaly.cc', 'littlebear.samya@gmail.com', 'noreply@portaly.cc', 'support@portaly.cc'],
  LABEL_DONE: 'SlowMate/已發碼',
  LABEL_REVIEW: 'SlowMate/需人工處理',
  MAX_REMEMBERED_IDS: 500
};

/* ------------------------------------------------------------------ */
/* 安裝                                                                 */
/* ------------------------------------------------------------------ */

function setup() {
  if (!getSecret_()) {
    throw new Error('請先在「專案設定 → 指令碼屬性」新增 GENERATE_CODE_SECRET');
  }
  const handlers = ['processPortalyOrders', 'processRecentOrders', 'catchUpOrders'];
  ScriptApp.getProjectTriggers()
    .filter((t) => handlers.indexOf(t.getHandlerFunction()) !== -1)
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processRecentOrders').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('catchUpOrders').timeBased().everyHours(6).create();
  getOrCreateLabel_(CONFIG.LABEL_DONE);
  getOrCreateLabel_(CONFIG.LABEL_REVIEW);
  Logger.log('✅ 已建立「每 1 分鐘」即時檢查與「每 6 小時」補漏檢查，開始處理近 7 天的訂單…');
  catchUpOrders();
}

/** 每 1 分鐘：近 1 天的新訂單 */
function processRecentOrders() {
  processPortalyOrders_(CONFIG.FAST_WINDOW);
}

/** 每 6 小時：近 7 天補漏（Gmail / Azure 暫時故障時的保險） */
function catchUpOrders() {
  processPortalyOrders_(CONFIG.CATCHUP_WINDOW, true);
}

/** 舊版觸發器名稱相容 */
function processPortalyOrders() {
  processRecentOrders();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

function processPortalyOrders_(window, fullScan) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5 * 1000)) return; // 上一輪還在跑，下一分鐘再來
  try {
    const secret = getSecret_();
    if (!secret) throw new Error('缺少指令碼屬性 GENERATE_CODE_SECRET');
    const props = PropertiesService.getScriptProperties();
    const handled = loadHandledIds_();
    // 早於這個時間點的對話都已全部處理完畢，可直接略過（不讀信件內容，節省執行時間額度）
    const doneBefore = fullScan ? 0 : Number(props.getProperty('DONE_BEFORE_MS') || 0);
    let pendingRetry = false;
    let newestSeen = doneBefore;

    GmailApp.search(`${CONFIG.BASE_QUERY} ${window}`, 0, 50).forEach((thread) => {
      const lastMs = thread.getLastMessageDate().getTime();
      if (lastMs <= doneBefore) return;
      newestSeen = Math.max(newestSeen, lastMs);
      thread.getMessages().forEach((message) => {
        const msgId = message.getId();
        if (handled.has(msgId)) return;

        const order = parsePortalyOrder(message.getPlainBody() || stripHtml_(message.getBody()));
        if (!order.orderId || !order.buyerEmail) {
          notifyOwner_(message, order, '無法從訂單通知信解析出' + (!order.orderId ? '訂單編號' : '買家 Email'));
          thread.addLabel(getOrCreateLabel_(CONFIG.LABEL_REVIEW));
          handled.add(msgId);
          return;
        }

        const result = callGenerateCode_(secret, order);
        if (result.ok) {
          let delivery = result.delivery;
          // Function 沒寄出序號信（寄信失敗或未設定 Gmail）→ 由本腳本直接以 GmailApp 寄出
          if (!result.idempotent && !result.emailSent && result.code) {
            try {
              sendCodeEmail_(order.buyerEmail, result.code, result.magicLink);
              delivery = 'apps_script';
            } catch (err) {
              notifyOwner_(message, order, `序號 ${result.code} 已建立，但序號信寄送失敗：${err}\n請手動轉寄 Magic Link：${result.magicLink}`);
              thread.addLabel(getOrCreateLabel_(CONFIG.LABEL_REVIEW));
            }
          }
          Logger.log(`✅ 訂單 ${order.orderId} → ${order.buyerEmail}（HTTP ${result.status}${result.idempotent ? '，先前已發過' : ''}，寄信：${delivery}）`);
          thread.addLabel(getOrCreateLabel_(CONFIG.LABEL_DONE));
          handled.add(msgId);
        } else if (result.retry) {
          pendingRetry = true;
          Logger.log(`⏳ 訂單 ${order.orderId} 暫時失敗（${result.status}），下一輪重試：${result.error}`);
        } else {
          notifyOwner_(message, order, `generateCode 回應 HTTP ${result.status}：${result.error}`);
          thread.addLabel(getOrCreateLabel_(CONFIG.LABEL_REVIEW));
          handled.add(msgId);
        }
      });
    });

    saveHandledIds_(handled);
    // 有待重試的訂單時不推進時間點，下一輪會再讀到它
    if (!fullScan && !pendingRetry && newestSeen > doneBefore) {
      props.setProperty('DONE_BEFORE_MS', String(newestSeen));
    }
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 解析 Portaly 訂單信                                                    */
/* ------------------------------------------------------------------ */

/**
 * 從信件純文字解析：
 *   orderId    「訂單編號：9M6KsDZl6CnR4vg15PKE」
 *   buyerEmail 標示為 Email / 電子信箱 / 信箱 / 聯絡信箱 / 買家 的那一行；找不到時取第一個不在 IGNORE_EMAILS 的信箱
 *   amount     「金額 / 總計 / 合計 / 實付 / 付款」那一行的數字；找不到時取第一個 NT$ / TWD / 元 金額
 */
function parsePortalyOrder(text) {
  const body = String(text || '').replace(/\r/g, '');
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

  const orderMatch = body.match(/訂單編號\s*[：:]\s*([A-Za-z0-9_-]{6,})/);
  const orderId = orderMatch ? orderMatch[1] : '';

  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const hasEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/; // 非 global，避免 lastIndex 殘留
  const ignore = CONFIG.IGNORE_EMAILS.map((e) => e.toLowerCase());
  const isCandidate = (e) => ignore.indexOf(e.toLowerCase()) === -1 && !/@portaly\.cc$/i.test(e);

  let buyerEmail = '';
  const labelled = lines.find((l) => /(e-?mail|電子信箱|電子郵件|聯絡信箱|信箱|買家|購買人|贊助者)/i.test(l) && hasEmail.test(l));
  if (labelled) {
    buyerEmail = (labelled.match(emailRe) || []).find(isCandidate) || '';
  }
  if (!buyerEmail) {
    buyerEmail = (body.match(emailRe) || []).find(isCandidate) || '';
  }

  const moneyRe = /(?:NT\$|NTD|TWD|\$)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:元|TWD|NTD)/i;
  let amount = '';
  const amountLine = lines.find((l) => /(金額|總計|合計|實付|付款|小計|價格)/.test(l) && moneyRe.test(l));
  const m = (amountLine || body).match(moneyRe);
  if (m) amount = (m[1] || m[2] || '').replace(/,/g, '');

  return { orderId: orderId, buyerEmail: buyerEmail.toLowerCase(), amount: amount };
}

/* ------------------------------------------------------------------ */
/* 呼叫 SlowMate API                                                     */
/* ------------------------------------------------------------------ */

function callGenerateCode_(secret, order) {
  try {
    const res = UrlFetchApp.fetch(CONFIG.API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-slowmate-secret': secret },
      payload: JSON.stringify({
        sponsor_email: order.buyerEmail,
        amount: order.amount || undefined,
        order_id: order.orderId,
        notify: true
      }),
      muteHttpExceptions: true
    });
    const status = res.getResponseCode();
    let data = {};
    try { data = JSON.parse(res.getContentText() || '{}'); } catch (e) { data = {}; }
    if (status === 200 || status === 201) {
      return {
        ok: true,
        status: status,
        idempotent: !!data.idempotent,
        emailSent: data.email_sent === true,
        delivery: data.delivery || '',
        code: data.code || '',
        magicLink: data.magic_link || `${CONFIG.APP_URL}?code=${encodeURIComponent(data.code || '')}`
      };
    }
    return { ok: false, status: status, retry: status >= 500 || status === 429, error: data.message || data.error || res.getContentText().slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, retry: true, error: String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* 備援：由 Apps Script 直接寄出序號信（與 Function 寄出的版型一致）          */
/* ------------------------------------------------------------------ */

function sendCodeEmail_(to, code, magicLink) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FBF9F5;font-family:'Noto Sans TC',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF9F5;"><tr><td align="center" style="padding:28px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E6E1D6;border-radius:20px;"><tr><td style="padding:28px 24px;color:#2C3531;">
      <div style="font-family:'Noto Serif TC',Georgia,serif;font-size:14px;letter-spacing:2px;color:#435E4F;font-weight:700;">SlowMate 慢旅伴 · AI 慢旅行程規劃師</div>
      <h1 style="font-family:'Noto Serif TC',Georgia,serif;font-size:21px;margin:12px 0;">☕ 謝謝你的隨喜贊助！</h1>
      <p style="font-size:14px;line-height:1.8;color:#6E7873;margin:0 0 18px;">你的支持讓 SlowMate 慢旅伴能繼續陪伴更多旅人慢慢走。以下是你的專屬<strong>一次性解鎖序號</strong>：</p>
      <div style="text-align:center;background:#E6EFEA;border:1px dashed #5B7B6A;border-radius:14px;padding:18px 10px;font-family:'SFMono-Regular',Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:3px;color:#435E4F;">${esc(code)}</div>
      <div style="text-align:center;margin:22px 0 6px;"><a href="${esc(magicLink)}" style="display:inline-block;background:#5B7B6A;color:#FFFFFF;text-decoration:none;font-weight:700;border-radius:12px;padding:12px 26px;font-size:15px;">✨ 一鍵帶入序號，回到 SlowMate 規劃旅程</a></div>
      <p style="font-size:13px;line-height:1.8;color:#6E7873;margin:18px 0 0;">• 一組序號可完整生成 1 次慢旅行程，<strong>不限信箱</strong>，也可以轉贈給旅伴使用。<br>• 只有在行程「成功生成」後才會核銷；若遇到當日名額已滿或生成失敗，序號會完整保留。</p>
    </td></tr></table>
    <div style="font-size:12px;color:#6E7873;margin-top:14px;">有任何問題歡迎私訊 IG @samya_traveler · Curated Slow Travel</div>
  </td></tr></table>
</body></html>`;
  const text = `謝謝你的隨喜贊助！\n\n你的 SlowMate 慢旅伴一次性解鎖序號：${code}\n\n一鍵帶入序號：${magicLink}\n\n` +
    '• 一組序號可完整生成 1 次慢旅行程，不限信箱，也可以轉贈給旅伴使用。\n' +
    '• 只有在行程成功生成後才會核銷；若遇到當日名額已滿或生成失敗，序號會完整保留。\n\n有任何問題歡迎私訊 IG @samya_traveler';
  GmailApp.sendEmail(to, '☕ 謝謝你的贊助！這是你的 SlowMate 慢旅伴一次性解鎖序號', text, {
    htmlBody: html,
    name: 'SlowMate 慢旅伴'
  });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function getSecret_() {
  return (PropertiesService.getScriptProperties().getProperty('GENERATE_CODE_SECRET') || '').trim();
}

function loadHandledIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty('HANDLED_MESSAGE_IDS');
  try { return new Set(JSON.parse(raw || '[]')); } catch (e) { return new Set(); }
}

function saveHandledIds_(set) {
  const ids = Array.from(set).slice(-CONFIG.MAX_REMEMBERED_IDS);
  PropertiesService.getScriptProperties().setProperty('HANDLED_MESSAGE_IDS', JSON.stringify(ids));
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function stripHtml_(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}

function notifyOwner_(message, order, reason) {
  const link = message ? `https://mail.google.com/mail/u/0/#all/${message.getId()}` : '';
  GmailApp.sendEmail(
    CONFIG.OWNER_EMAIL,
    '⚠️ SlowMate 自動發碼需要人工處理',
    `${reason}\n\n訂單編號：${order.orderId || '（未解析）'}\n買家 Email：${order.buyerEmail || '（未解析）'}\n金額：${order.amount || '（未解析）'}\n原始通知信：${link}\n\n` +
      '手動補發：到 script.google.com 執行 debugLatestOrderEmail 檢查格式，或請 Claude 協助以 generateCode 發碼。'
  );
}

/* ------------------------------------------------------------------ */
/* 除錯                                                                 */
/* ------------------------------------------------------------------ */

function debugLatestOrderEmail() {
  const threads = GmailApp.search('from:service@portaly.cc subject:"您有一筆新的訂單"', 0, 1);
  if (!threads.length) return Logger.log('找不到 Portaly 訂單通知信');
  const msgs = threads[0].getMessages();
  const msg = msgs[msgs.length - 1];
  const text = msg.getPlainBody() || stripHtml_(msg.getBody());
  Logger.log('----- 信件純文字 -----\n' + text);
  Logger.log('----- 解析結果 -----\n' + JSON.stringify(parsePortalyOrder(text), null, 2));
}

function dryRun() {
  GmailApp.search(`${CONFIG.BASE_QUERY} ${CONFIG.CATCHUP_WINDOW}`, 0, 20).forEach((thread) =>
    thread.getMessages().forEach((m) => Logger.log(m.getDate() + ' ' + JSON.stringify(parsePortalyOrder(m.getPlainBody() || stripHtml_(m.getBody())))))
  );
}
