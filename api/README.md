# SlowMate 慢旅伴 API（Azure Functions · Node.js v4 · TypeScript）

「SlowMate 慢旅伴｜AI 慢旅行程規劃師」的 Serverless 後端。前端是 `../slowmate/index.html`，
放在 Hugo 部落格 repo 的 `static/slowmate/index.html`，公開網址 `https://samya-traveler.github.io/slowmate/`。

- **AI**：Azure OpenAI Service `gpt-4.1`（Chat Completions + `response_format: json_object`）
- **資料庫**：Azure Table Storage（4 張表，首次呼叫時自動建立）
- **發信**：Gmail SMTP（Nodemailer，`smtp.gmail.com:465`），不需自訂網域

| Function | Route | Auth | 用途 |
|---|---|---|---|
| `planTrip` | `GET /api/plan` | anonymous | 查今日（台灣時間）剩餘名額 `{ remaining_quota }` |
| `planTrip` | `POST /api/plan` | anonymous | 白名單 → 資格（Email OTP 首次免費額度 / 序號）→ 每日 50 次 → gpt-4.1 → 成功才核銷 |
| `sendOtp` | `POST /api/send-otp` | anonymous | 首次免費額度的 6 位數 Email 驗證碼 |
| `checkCode` | `POST /api/check-code` | anonymous | 唯讀查詢序號狀態（`valid` / `processing` / `used` / `not_found`），不鎖定也不核銷 |
| `sendEmail` | `POST /api/send-email` | anonymous | 以 Gmail 寄出 HTML 行程信 |
| `generateCode` | `POST /api/generateCode`（舊路徑 `/api/generate-code` 仍可用） | 程式內驗證：`?code=` / `x-functions-key` / `x-slowmate-secret` 擇一 | 給 Logic App 產生 `SLOW-XXXX-YYYY` 序號 |

## 資料表

| 表 | PartitionKey | RowKey | 主要欄位 |
|---|---|---|---|
| `DailyUsage` | `Daily`（每日成功生成）/ `EmailDaily`（每日寄信封數） | 台灣日期 `YYYY-MM-DD` | `usedCount` |
| `UserProfiles` | `User` | 小寫 email | `free_quota_used`、`used_at`、`generation_count` |
| `EmailOtps` | `OTP` | 小寫 email | `otp_hash`（不存明碼）、`expires_at`（10 分鐘）、`attempt_count`（最多 5 次）、`last_sent_at`（60 秒冷卻）、`send_day` / `send_count` |
| `RedeemCodes` | `Code` | 序號（`trim().toUpperCase()`） | `is_used`、`status`（`unused` / `processing` / `used`）、`locked_at`、`sponsor_email`、`amount`、`tier`、`order_id`、`created_at`、`used_at` |

Email 當 RowKey 時只會轉義 Table Storage 不允許的字元（`/ \ # ?`、控制字元與 `%`），一般信箱在 Portal 中可直接閱讀。

## 資格分流（POST /api/plan）

| 情況 | 行為 |
|---|---|
| 管理員白名單 `sufuf3149@gmail.com` | 免 OTP、免序號、不扣每日名額 |
| 只帶有效序號 | 免 OTP，直接核銷序號（認碼不認信箱）；若免費額度未用過，回傳 `free_quota_preserved: true` |
| 帶 `otp_code` 且免費額度未用過 | 驗證 OTP → 使用免費額度；若同時帶有效序號，序號不核銷並回傳 `code_preserved: true` |
| 免費額度已用過、沒有有效序號 | 402 `payment_required` |
| 免費額度未用過、沒帶 OTP 也沒帶序號 | 403 `otp_required`（前端改呼叫 `/api/send-otp`） |

OTP 錯誤會回 400，`error` 為 `invalid_otp`（附 `attempts_left`）、`otp_expired`、`otp_locked` 或 `otp_missing`。
OTP 只有在行程「成功生成」後才作廢；AI 生成失敗時，10 分鐘內可用同一組驗證碼重試。

`/api/send-otp` 會先擋拋棄式信箱（400 `disposable_email`，清單在 `shared/disposable.ts`，可用 `DISPOSABLE_EXTRA_DOMAINS` 追加）。
若該信箱已用過免費額度，會直接回 402、不寄信；今日全站名額已滿時回 429、不寄信。

## 序號狀態機（零損耗回滾）

邏輯集中在 `shared/redeemCodes.ts`，所有寫入都帶 ETag 樂觀鎖：

1. 收到序號 → 不存在或已使用回 400；`status = "processing"` 且 `locked_at` 未滿 3 分鐘回 409 `code_processing`。
2. 預扣每日名額（額滿回 429，序號完全沒被動到）。
3. 把序號改為 `status = "processing"`、寫入 `locked_at`。雙開分頁同時送出時只有一個請求拿得到鎖，另一個回 409。
4. 呼叫 gpt-4.1：成功回傳合法 JSON → `is_used = true`、`status = "used"`、寫入 `used_at`；失敗 → 回滾為 `is_used = false`、`status = "unused"`，並退回每日名額。
5. 若 Function 在生成中途當掉沒能回滾，超過 3 分鐘的 `processing` 會被視為逾時，可以重新使用。

免費額度走相同流程（`UserProfiles` 的租約），失敗時一樣不會被消耗。

## 回應碼

| 狀態碼 | 意義 |
|---|---|
| 200 | 成功 |
| 400 | `invalid_input`、`invalid_code`、OTP 錯誤、`disposable_email` |
| 402 | `payment_required` |
| 403 | `otp_required` |
| 409 | 序號或免費額度正在另一個視窗生成中 |
| 429 | `token_limit_reached`、`otp_cooldown`、`email_daily_cap` |
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
3. 寄件人固定為 `"SlowMate 慢旅伴" <littlebear.samya@gmail.com>`。
4. Gmail 個人帳號每日約可寄 500 封，`EMAIL_DAILY_CAP` 預設 400 封（驗證信與行程信合計）。

負責的信件：6 位數 OTP 驗證碼信、HTML 行程表信（頁尾附「慢旅伴的小叮嚀」）、Portaly 贊助序號信（附 Magic Link）。

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
| `ALLOWED_ORIGINS` | 預設 `https://samya-traveler.github.io` |

選填項目：

| 變數 | 預設值 |
|---|---|
| `DAILY_GLOBAL_LIMIT` | 50 |
| `ADMIN_EMAILS` | `sufuf3149@gmail.com` |
| `EMAIL_DAILY_CAP` | 400 |
| `AI_TIMEOUT_MS` | 120000 |
| `MAIL_FROM_NAME` / `MAIL_REPLY_TO` | `SlowMate 慢旅伴` / 空 |
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
3. 執行 `setup` 並授權：建立每 5 分鐘觸發器，並立即處理近 3 天的訂單。

每封 `from:service@portaly.cc`、主旨「您有一筆新的訂單」的信會解析 `訂單編號`、買家 Email、金額，以 `order_id` 冪等呼叫 `generateCode`，
由 Function 透過 Gmail 寄出序號信。解析失敗或 API 回 4xx 時會寄提醒信給自己並加上「SlowMate/需人工處理」標籤；5xx 下一輪自動重試。
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
