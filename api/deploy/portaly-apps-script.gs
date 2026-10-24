/**
 * SlowMate 慢旅伴 — Portaly 贊助自動發碼（Google Apps Script）
 *
 * 安裝在收 Portaly 訂單通知的 Gmail（littlebear.samya@gmail.com）：
 *   1. 到 https://script.google.com 以 littlebear.samya@gmail.com 登入 → 新增專案，貼上本檔全部內容。
 *   2. 左側「專案設定」→「指令碼屬性」新增：
 *        GENERATE_CODE_SECRET = （Azure Portal → slowmate-api → Environment variables 裡的同名值）
 *   3. 上方函式選單選 setup → 執行 → 依指示授權（Gmail 與外部連線）。
 *      setup 會建立「每 5 分鐘」的觸發器，並先處理一次近 3 天的訂單。
 *
 * 運作方式：
 *   - 搜尋 from:service@portaly.cc 主旨「您有一筆新的訂單」的信件（逐封處理，同主旨被 Gmail 串成同一個對話也不會漏）。
 *   - 解析「訂單編號」、買家 Email、金額 → POST /api/generateCode（order_id 冪等：同一筆訂單永遠只發一組序號）。
 *   - 成功：記錄為已處理，並在對話加上標籤「SlowMate/已發碼」。
 *   - 解析不到買家 Email 或 API 回 4xx：寄一封提醒信給自己，標籤「SlowMate/需人工處理」，不再重試。
 *   - API 回 5xx 或連線失敗：下一輪（5 分鐘後）自動重試。
 *
 * 除錯：
 *   - debugLatestOrderEmail：把最新一封 Portaly 訂單信的純文字內容與解析結果印在「執行記錄」。
 *   - dryRun：只解析不呼叫 API。
 */

const CONFIG = {
  API_URL: 'https://slowmate-api.azurewebsites.net/api/generateCode',
  SEARCH_QUERY: 'from:service@portaly.cc subject:"您有一筆新的訂單" newer_than:3d',
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
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'processPortalyOrders')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processPortalyOrders').timeBased().everyMinutes(5).create();
  getOrCreateLabel_(CONFIG.LABEL_DONE);
  getOrCreateLabel_(CONFIG.LABEL_REVIEW);
  Logger.log('✅ 已建立每 5 分鐘的觸發器，開始處理近 3 天的訂單…');
  processPortalyOrders();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

function processPortalyOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return; // 上一輪還在跑
  try {
    const secret = getSecret_();
    if (!secret) throw new Error('缺少指令碼屬性 GENERATE_CODE_SECRET');
    const handled = loadHandledIds_();

    GmailApp.search(CONFIG.SEARCH_QUERY, 0, 50).forEach((thread) => {
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
          Logger.log(`✅ 訂單 ${order.orderId} → ${order.buyerEmail}（${result.status}${result.idempotent ? '，先前已發過' : ''}，${result.delivery}）`);
          thread.addLabel(getOrCreateLabel_(CONFIG.LABEL_DONE));
          handled.add(msgId);
        } else if (result.retry) {
          Logger.log(`⏳ 訂單 ${order.orderId} 暫時失敗（${result.status}），下一輪重試：${result.error}`);
        } else {
          notifyOwner_(message, order, `generateCode 回應 HTTP ${result.status}：${result.error}`);
          thread.addLabel(getOrCreateLabel_(CONFIG.LABEL_REVIEW));
          handled.add(msgId);
        }
      });
    });

    saveHandledIds_(handled);
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
      // 序號已建立；若 Function 寄信失敗（email_sent=false）會由下方提醒信告知
      if (data.email_sent === false && !data.idempotent) {
        notifyOwner_(null, order, `序號已建立但寄信失敗，請手動轉寄 magic link：${data.magic_link || ''}`);
      }
      return { ok: true, status: status, idempotent: !!data.idempotent, delivery: data.delivery || '' };
    }
    return { ok: false, status: status, retry: status >= 500 || status === 429, error: data.message || data.error || res.getContentText().slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, retry: true, error: String(err) };
  }
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
  GmailApp.search(CONFIG.SEARCH_QUERY, 0, 20).forEach((thread) =>
    thread.getMessages().forEach((m) => Logger.log(m.getDate() + ' ' + JSON.stringify(parsePortalyOrder(m.getPlainBody() || stripHtml_(m.getBody())))))
  );
}
