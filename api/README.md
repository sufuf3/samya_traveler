# SlowMate · AI 慢旅行程規劃助手 API（Azure Functions · Node.js v4 · TypeScript）

「SlowMate · AI 慢旅行程規劃助手」的 Serverless 後端。前端是 `../slowmate/index.html`，
放在 Hugo 部落格 repo 的 `static/slowmate/index.html`，公開網址 `https://samya-traveler.github.io/slowmate/`。

- **AI**：Azure OpenAI Service `gpt-4.1`（Chat Completions + `response_format: json_object`）
- **資料庫**：Azure Table Storage（4 張表，首次呼叫時自動建立）
- **發信**：Gmail SMTP（Nodemailer，`smtp.gmail.com:465`），不需自訂網域

| Function | Route | Auth | 用途 |
|---|---|---|---|
| `planTrip` | `GET /api/plan` | anonymous | 查今日（台灣時間）剩餘名額 `{ remaining_quota }` |
| `planTrip` | `POST /api/plan` | anonymous | 白名單 → 資格（Email OTP 首次免費額度 / 序號）→ 每日 50 次 → gpt-4.1 → 成功才核銷 |
| `sendOtp` | `POST /api/send-otp` | anonymous | 首次免費額度的 6 位數 Email 驗證碼 |
| `checkCode` | `POST /api/check-code` | anonymous | 唯讀查詢序號狀態（`valid` / `processing` / `exhausted` / `companion_used` / `email_used` / `not_found`）與剩餘次數，不鎖定也不核銷 |
| `sendEmail` | `POST /api/send-email` | anonymous | 以 Gmail 寄出 HTML 行程信 |
| `generateCode` | `POST /api/generateCode`（舊路徑 `/api/generate-code` 仍可用） | 程式內驗證：`?code=` / `x-functions-key` / `x-slowmate-secret` 擇一 | 模式 A：Portaly 自動發碼（依金額與 `PROMO_MODE` 決定方案並寄序號信）；模式 B：戰情室批次 / 公用碼（需 `x-admin-secret`，不寄信） |

## 資料表

| 表 | PartitionKey | RowKey | 主要欄位 |
|---|---|---|---|
| `DailyUsage` | `Daily`（雙水池名額）/ `EmailDaily`（每日寄信封數） | 台灣日期 `YYYY-MM-DD` | `Daily`：`free_used`（免費席 ≤ 50）、`code_used`（序號保留席 ≤ 30）、`vip_whitelist_used`（管理員，只統計）；`EmailDaily`：`usedCount` |
| `UserProfiles` | `User` | 小寫 email | `free_quota_used`、`used_at`、`total_trips` |
| `EmailOtps` | `OTP` | 小寫 email | `otp_hash`（不存明碼）、`expires_at`（10 分鐘）、`attempt_count`（最多 5 次）、`last_sent_at`（60 秒冷卻）、`send_day` / `send_count` |
| `RedeemCodes` | `RedeemCode`（2026/10 以前的序號在舊的 `Code`，讀取時兩邊都查） | 序號（`trim().toUpperCase()`，4~32 碼英數與 `-`） | `OwnerEmail`、`Amount`、`TotalUses`、`RemainingUses`、`AllowSameEmail`、`UsedByEmails`（JSON 陣列）、`CampaignTag`、`IsUsed`、`PlanName`、`PendingLocks`、`OrderId`、`CreatedAt`、`UsedAt` |

Email 當 RowKey 時只會轉義 Table Storage 不允許的字元（`/ \ # ?`、控制字元與 `%`），一般信箱在 Portal 中可直接閱讀。

## 資格分流（POST /api/plan）

| 情況 | 行為 |
|---|---|
| 管理員白名單（Header `x-admin-secret` = `ADMIN_SECRET`） | 免 OTP、免序號、不受 50/80 席限制，只累計 `vip_whitelist_used`；金鑰錯誤回 401。Email 本身不具任何特權 |
| 帶 `otp_code` 且免費額度未用過 | 驗證 OTP → 使用免費席；若同時帶有效序號，序號不扣次數並回傳 `code_preserved: true` |
| 只帶序號（`redeem_code` 或 `redeemCode`） | 免 OTP；呼叫 AI 前檢查剩餘次數與信箱權限，成功才扣次數；免費席未滿先扣免費席，滿了才扣序號保留席；回傳 `remainingUses`；首次免費額度保留（`free_quota_preserved`） |
| 序號不存在 / 次數用完 | 402 `code_unavailable`（`reason: not_found / exhausted`） |
| 旅伴或活動公用碼：此信箱已用過 1 次 | 403 `code_email_used`（`reason: companion_used / email_used`），本次未扣額度 |
| 免費額度已用過、沒有有效序號 | 402 `payment_required` |
| 今日免費席已滿、沒有序號 | 429 `free_pool_full`（`/api/send-otp` 也會回 429，不寄信） |
| 免費席 + 序號保留席全滿 | 429 `token_limit_reached` |
| 免費額度未用過、沒帶 OTP 也沒帶序號 | 403 `otp_required`（前端改呼叫 `/api/send-otp`） |

### 雙水池每日名額

以台灣時間計算，每日 00:00 重置。`GET /api/plan` 回傳：

```json
{ "free_remaining": 50, "vip_pool_remaining": 30, "code_total_remaining": 80 }
```

- 免費席（`FREE_DAILY_LIMIT`，未設定時沿用 `DAILY_GLOBAL_LIMIT`，預設 50）：首次免費試用者只能用這一池。
- 序號保留席（`VIP_POOL_LIMIT`，預設 30）：持序號者先用免費席，免費席滿了才動用保留席，所以序號者每日最多可兌換 80 席。
- 預扣時記下實際扣到的欄位；AI 生成失敗時只把那一席還回去，序號 `used_count` 與免費資格都不動（零損耗）。

### 贊助方案與多次數序號

`/api/generateCode` 依贊助金額與 App Setting `PROMO_MODE` 發碼（方案表在 `shared/plans.ts`）；前端 `index.html` 的 `IS_XMAS_PROMO` 要同步切換贊助彈窗文案。

| 模式 | 金額 | 方案 | 前綴 | `TotalUses` | `AllowSameEmail` | `CampaignTag` |
|---|---|---|---|---|---|---|
| `NORMAL`（預設） | ≥ 488 | ✨ 慢旅玩家全票 | `SM10-` | 10 | `false` | `PORTALY_NORMAL` |
| | ≥ 300 | 🌿 旅伴同樂包 | `SM5-` | 5 | `false` | `PORTALY_NORMAL` |
| | 其他（含 88、無法解析） | ☕ 單人微調體驗 | `SM1-` | 1 | `true` | `PORTALY_NORMAL` |
| `XMAS` | ≥ 488 | 🎅 2027 全年慢旅年票 | `XMAS14-` | 14 | `false` | `PORTALY_XMAS` |
| | ≥ 300 | 🦌 聖誕旅伴加碼包 | `XMAS7-` | 7 | `false` | `PORTALY_XMAS` |
| | ≥ 199 | 🎄 聖誕雙人福袋 | `XMAS3-` | 3 | `true` | `PORTALY_XMAS` |
| | 其他（含 88） | ☕ 單人微調體驗 | `SM1-` | 1 | `true` | `PORTALY_NORMAL` |

`AllowSameEmail`：

- `true`：不限信箱，誰都可以用到次數用完（單次碼、聖誕雙人福袋、`GIFT10-`、`EARLY1-` 等）。
- `false` 且有 `OwnerEmail`（300 / 488 多人方案）：買家本人可重複使用到次數歸零；其他旅伴信箱每個限用 1 次（記在 `UsedByEmails`）。
- `false` 且 `OwnerEmail = ""`（戰情室公用碼，例如 `NOV-VIP`）：每個信箱限用 1 次。

「每個信箱限用 1 次」以單一序號為單位：同一信箱可以各用 `SURVEY-VIP1`、`SURVEY-VIP2` 一次。完整的使用紀錄存在 `RedeemCodeUsers` 資料表（PartitionKey = 序號、RowKey = 小寫 email）；
`UsedByEmails` 欄位只保留前約 1,000 筆方便在 Portal 閱讀（Table Storage 單一字串欄位上限 64 KB）。`max_uses` 上限 100,000。

同一組序號可以多人同時使用：每次生成在 `PendingLocks` 各持有一把鎖，`RemainingUses - 進行中的鎖 > 0` 才能再鎖，超過 3 分鐘的鎖自動失效。
舊資料自動換算：`max_uses / used_count / allow_same_email / used_by_emails / campaign_tag / sponsor_email` 對應到新欄位，最早的一次性序號視為 `RemainingUses = IsUsed ? 0 : 1`；舊序號被使用時會在原本那一列補上新欄位。

OTP 錯誤會回 400，`error` 為 `invalid_otp`（附 `attempts_left`）、`otp_expired`、`otp_locked` 或 `otp_missing`。
OTP 只有在行程「成功生成」後才作廢；AI 生成失敗時，10 分鐘內可用同一組驗證碼重試。

`/api/send-otp` 會先擋拋棄式信箱（400 `disposable_email`，清單在 `shared/disposable.ts`，可用 `DISPOSABLE_EXTRA_DOMAINS` 追加）。
若該信箱已用過免費額度，會直接回 402、不寄信；今日免費席已滿時回 429 `free_pool_full`、不寄信。

## 管理員模式

管理員不再以 Email 白名單判斷（Email 會出現在公開的前端原始碼，任何人輸入即可無限免費使用）。改為：

1. 後端 App Setting `ADMIN_SECRET`（至少 32 字元的隨機字串；舊名 `ADMIN_TOKEN` 仍可使用，在 Azure Portal → `slowmate-api` → Environment variables 查看）。
2. 開啟 `https://samya-traveler.github.io/slowmate/?admin=1` → 點「🔐 戰情室」→ 輸入金鑰：
   金鑰只存在該瀏覽器的 localStorage，之後的 `/api/plan` 請求會帶上 `x-admin-secret` header（白名單：免 OTP、不受名額限制）。
3. 關閉：戰情室內按「登出」，或開啟 `…/slowmate/?admin=off`。金鑰錯誤時後端回 401，前端會自動清除本機金鑰。
4. 金鑰外洩時，直接在 Portal 換一組新的 `ADMIN_SECRET`，舊金鑰立即失效。

### 戰情室 API（`/api/dashboard-stats`，Header `x-admin-secret`）

函式名稱為 `adminStats`，但路由不能用 `/api/adminStats`：Azure Functions 保留以 `admin` 開頭的路由給主機管理 API，會直接回 404。

- `GET`：今日雙水池用量、近 7 日趨勢、用戶總數、各 `campaign_tag` 核銷統計與序號核銷排行榜（前 20 名）。
- `POST`（與 `POST /api/generateCode` 帶管理員金鑰的模式 B 相同）：產生行銷序號，不寄信、`OwnerEmail` 為空，回傳序號與 Magic Link（`…/slowmate/?code=…`）。
  - 批次產碼：`{ "mode": "batch", "prefix": "GIFT10-", "count": 20, "max_uses": 10, "allow_same_email": true, "campaign_tag": "REELS_BIRTH" }`
  - 指定公用碼：`{ "mode": "custom", "custom_code": "NOV-VIP", "max_uses": 50, "allow_same_email": false, "campaign_tag": "NOV_GIFT" }`（已存在則更新次數與規則，已用掉的次數照算）

## 序號狀態機（零損耗回滾）

邏輯集中在 `shared/redeemCodes.ts`，所有寫入都帶 ETag 樂觀鎖：

1. 收到序號 → 不存在或次數用完回 402；旅伴 / 公用碼的信箱已用過回 403；剩餘次數都在生成中回 409 `code_processing`。
2. 預扣雙水池名額（額滿回 429，序號完全沒被動到）。
3. 在 `PendingLocks` 加入一把鎖、`Status = "processing"`。雙開分頁同時送出時，超過剩餘次數的請求回 409。
4. 呼叫 gpt-4.1：成功回傳合法 JSON → `RemainingUses - 1`、非買家信箱加入 `UsedByEmails`，扣完時 `IsUsed = true`；失敗 → 只移除自己那把鎖，並退回名額。
5. 若 Function 在生成中途當掉沒能回滾，超過 3 分鐘的鎖會被視為逾時，次數自動回來。

免費額度走相同流程（`UserProfiles` 的租約），失敗時一樣不會被消耗。

## 安全防護

- **CORS 白名單**：`ALLOWED_ORIGINS`（預設 `https://samya-traveler.github.io`、`http://localhost:1313`、`http://127.0.0.1:5500`，不接受 `*`）。Azure 平台層 CORS 也要設定相同清單（`setup-azure.sh` 會處理）。
  瀏覽器從其他網站呼叫時直接回 403 `forbidden_origin`、不執行任何動作（CORS 只擋讀取回應，擋不住寄信等副作用）；沒有 `Origin` 的伺服器端呼叫（curl、Apps Script）仍由各端點自己的驗證把關。
- **輸入長度**：`destination` 30 字、`user_wishes` 300 字、`arrival_time` / `departure_time` 20 字（超過的部分截斷；前端 `maxlength` 相同）。
- **Prompt Injection**：使用者文字一律包在 `<user_input>` 標籤內，`<` `>` 轉成全形避免提早關閉標籤；System Prompt 聲明忽略標籤內任何修改規則、要求非 JSON 或詢問系統提示詞的指令。
- **管理員金鑰**：以 SHA-256 定長摘要 + `crypto.timingSafeEqual` 比對。同一 IP 15 分鐘內錯誤 5 次 → 429 `admin_locked`，鎖 15 分鐘（含戰情室、`x-admin-secret` 與 `generateCode` 的 secret）；輸入正確時清除計數。
- **寄信頻率**：`/api/send-otp` 與 `/api/send-email` 各自限制同一 IP 10 分鐘內最多寄出 5 封（429 `ip_rate_limited`），另有既有的單一信箱冷卻與每日寄信總量上限。
- IP 取 `x-forwarded-for` 的最後一個位址（Azure 前端附加），計數存在 `RateLimits` 資料表（PartitionKey = 用途、RowKey = IP 的 SHA-256），不存 IP 明碼。

## 回應碼

| 狀態碼 | 意義 |
|---|---|
| 200 | 成功 |
| 400 | `invalid_input`、`invalid_code`、OTP 錯誤、`disposable_email` |
| 402 | `payment_required`（免費額度已用過）、`code_unavailable`（序號不存在 / 次數用完） |
| 403 | `otp_required`、`code_email_used`（旅伴 / 公用碼信箱已用過）、`forbidden_origin`（非白名單網站） |
| 409 | 序號或免費額度正在另一個視窗生成中 |
| 429 | `free_pool_full`、`token_limit_reached`、`otp_cooldown`、`email_daily_cap`、`ip_rate_limited`、`admin_locked` |
| 502 / 504 | AI 生成或寄信失敗（已全數回滾） |

## AI 模型：Azure OpenAI gpt-4.1

以 REST 呼叫 `POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version={AZURE_OPENAI_API_VERSION}`：

- `api-key` 標頭驗證，`response_format: { type: "json_object" }` 強制輸出合法 JSON。
- `max_tokens`：1~5 天 8,000；6~14 天 14,000。`finish_reason` 為 `length` 或 `content_filter` 時視為失敗並回滾。
- 遇到 429 / 5xx 會依 `retry-after` 重試 1 次（最多等 10 秒），總時間不超過 `AI_TIMEOUT_MS`。
- System Prompt 採《Brutus》《&Premium》式的溫潤散文筆觸，並依 `start_date` 月份加入季節提示（冬季提早日落、夏季避開正午、春秋花季與楓季等，南半球目的地自動反轉季節），`todo_checklist` 會帶入對應的衣物裝備提醒。
- 1~5 天每天 3 個時段（上午 / 下午 / 傍晚）；6~14 天每天 2 個時段（上午 / 下午），文字精簡避免 JSON 被截斷。
- 回傳結果一律經 `shared/trip.ts` 驗證與清洗（天數與日期以後端計算為準、顏色只接受 HEX、`svg_theme` 只接受白名單）。

## 發信：Gmail SMTP

1. 寄件帳號 `littlebear.samya@gmail.com` 需先開啟**兩步驟驗證**。
2. 到 Google 帳戶 →「安全性」→「應用程式密碼」產生 16 碼密碼，設為 `GMAIL_APP_PASSWORD`（含空白貼上也可以，程式會自動去除）。
3. 寄件人固定為 `"SlowMate · AI 慢旅行程規劃助手" <littlebear.samya@gmail.com>`（可用 `MAIL_FROM_NAME` 覆寫）。
4. Gmail 個人帳號每日約可寄 500 封，`EMAIL_DAILY_CAP` 預設 400 封（驗證信與行程信合計）。

負責的信件：6 位數 OTP 驗證碼信、HTML 行程表信（頁尾附「SlowMate 的小叮嚀」）、Portaly 贊助序號信（附 Magic Link）。

## 環境變數（Function App → 設定 → 環境變數）

完整清單見 `local.settings.example.json`。

| 變數 | 說明 |
|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | 可省略，省略時改用 `AzureWebJobsStorage` |
| `AZURE_OPENAI_ENDPOINT` | 例 `https://<resource>.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI 金鑰 |
| `AZURE_OPENAI_DEPLOYMENT` | 預設 `gpt-4.1` |
| `AZURE_OPENAI_API_VERSION` | 預設 `2025-01-01-preview` |
| `GMAIL_USER` | 預設 `littlebear.samya@gmail.com` |
| `GMAIL_APP_PASSWORD` | Google 應用程式密碼（必填，否則無法寄信） |
| `GENERATE_CODE_SECRET` | 與 Logic App 共用的長隨機字串 |
| `OTP_SECRET` | OTP 雜湊用的 pepper，建議另設一組長隨機字串 |
| `ADMIN_SECRET` | 管理員金鑰（至少 32 字元，建議 `openssl rand -hex 32`；舊名 `ADMIN_TOKEN` 仍可使用）；未設定時管理員模式與戰情室一律拒絕，也可用於 `/api/generateCode` 認證 |
| `ALLOWED_ORIGINS` | 預設 `https://samya-traveler.github.io` |

選填項目：

| 變數 | 預設值 |
|---|---|
| `FREE_DAILY_LIMIT`（舊名 `DAILY_GLOBAL_LIMIT`） | 50（每日免費席） |
| `VIP_POOL_LIMIT` | 30（每日序號保留席） |
| `SURVEY_URL` | `https://forms.gle/WeFcWEu2NrPP8AWy8`（行程信「雙人慢旅共享禮」問卷連結） |
| `PROMO_MODE` | `NORMAL`（常態 88 / 300 / 488）；`XMAS` 開啟聖誕囤票祭（199 / 300 / 488） |
| `EMAIL_DAILY_CAP` | 400 |
| `AI_TIMEOUT_MS` | 120000 |
| `MAIL_FROM_NAME` / `MAIL_REPLY_TO` | `SlowMate · AI 慢旅行程規劃助手` / 空 |
| `OTP_MAX_SENDS_PER_DAY` | 5 |
| `DISPOSABLE_EXTRA_DOMAINS` | 空 |
| `GENERATE_CODE_FUNCTION_KEY` | 空（想沿用 Azure Function Key 時，把它的值貼在這裡） |
| `SLOWMATE_APP_URL` | `https://samya-traveler.github.io/slowmate/`（Magic Link 網址） |
| `PORTALY_URL` | `https://portaly.cc/samya_traveler` |

## 本機開發與部署

```bash
cd api
npm install
cp local.settings.example.json local.settings.json   # 填入金鑰
npx azurite-table --inMemoryPersistence &             # 本機 Table Storage
npm start                                             # = build + func start
```

一鍵建置 Azure 資源（Storage、Function App、Azure OpenAI gpt-4.1）與部署：見 `deploy/setup-azure.sh`。

部署後請完成以下設定：

- **前端**：把 `slowmate/index.html` 內的 `API_BASE_URL` 改成 `https://<your-function-app>.azurewebsites.net/api`，
  再把檔案放到 Hugo repo 的 `static/slowmate/index.html`。根目錄的部落格首頁不需要更動。
- **CORS**：腳本已設定 `https://samya-traveler.github.io`；本機 Hugo 開發（`http://localhost:1313`）請另外加入。

## 自動發碼：Google Apps Script（建議）

Portaly 訂單通知寄到個人 Gmail（`littlebear.samya@gmail.com`）。Logic App 不允許「個人 Gmail 連接器 + HTTP 呼叫」放在同一個流程，
因此改用 `deploy/portaly-apps-script.gs`，直接在該 Gmail 帳號內執行：

1. 以 `littlebear.samya@gmail.com` 登入 https://script.google.com → 新增專案 → 貼上 `portaly-apps-script.gs` 全部內容。
2. 「專案設定」→「指令碼屬性」新增 `GENERATE_CODE_SECRET`（值在 Azure Portal → `slowmate-api` → Environment variables）。
3. 執行 `setup` 並授權：建立「每 1 分鐘」即時檢查與「每 6 小時」補漏檢查（近 7 天），並立即處理一次。

每封 `from:service@portaly.cc`、主旨「您有一筆新的訂單」的信會解析 `訂單編號`、買家 Email、金額，以 `order_id` 冪等呼叫 `generateCode`，
由 Function 透過 Gmail 寄出序號信；若 Function 寄信失敗，腳本會改用 `GmailApp` 直接寄出同版型的序號信。
贊助者通常在付款後 1~2 分鐘內收到序號（1 分鐘是 Apps Script 觸發器的最短間隔；Portaly 目前沒有公開的 webhook）。
已處理完的對話會直接略過不讀內容，每分鐘的檢查通常不到 1 秒，遠低於個人帳號每日 90 分鐘的觸發器執行額度。
解析失敗或 API 回 4xx 時會寄提醒信給自己並加上「SlowMate/需人工處理」標籤；5xx 下一輪自動重試。
格式有疑問時執行 `debugLatestOrderEmail` 檢視原始內容與解析結果。

## Logic App 串接 generateCode（替代方案）

Portaly 贊助採「隨喜三階支持」：NT$ 88（輕量解鎖）/ 150（標準支持）/ 300（深度熱情）。三階權益完全一致，一次贊助換一組一次性序號。
`amount` 可傳 `150`、`"150"` 或 `"NT$ 150"`，會記錄在序號上並對應 `tier`；非三階金額仍照常發碼，只在記錄中留下警告。

觸發條件：收到 Portaly 贊助通知信。接著加入一個 HTTP 動作，設定如下：

- **Method**：`POST`，URI 為 `https://<app>.azurewebsites.net/api/generateCode`
- **認證（擇一即可）**：
  - URI 加上 `?code=<金鑰>`，或 Header `x-functions-key: <金鑰>`
  - Header `x-slowmate-secret: <金鑰>`

  金鑰需等於 App Setting 的 `GENERATE_CODE_SECRET` 或 `GENERATE_CODE_FUNCTION_KEY`；兩者都沒設定時一律拒絕。
  此端點為 `anonymous` 並在程式內驗證，因為 Azure 平台層的 Function Key 檢查無法做到「擇一」。程式讀不到平台產生的 Function Key，要沿用它請把值貼到 `GENERATE_CODE_FUNCTION_KEY`。
- **Body**：

  ```json
  { "sponsor_email": "<從信件解析>", "sponsor_name": "...", "amount": 150, "order_id": "<訂單編號>" }
  ```

函式行為：

- **重複贊助**：同一位贊助者第 2、3 次贊助時，只要 `order_id` 不同或沒提供，每次都會產生全新序號。只有傳入完全相同的 `order_id` 才會回傳同一組序號（`idempotent: true`），`portaly_order_id` 也接受為別名。
- **發信權責**：
  - 已設定 `GMAIL_APP_PASSWORD`、有 `sponsor_email`、且 `notify !== false` → 由 Function 以 Gmail 寄出序號信，回應 `delivery: "function"`。信中附一鍵帶入連結 `https://samya-traveler.github.io/slowmate/?code=SLOW-XXXX-YYYY`。
  - 否則只回傳序號 JSON，回應 `delivery: "logic_app"`，由 Logic App 自行寄出。回應中的 `magic_link` 可以直接放進 Logic App 的信件內容。
