# SlowMate API（Azure Functions · Node.js v4 · TypeScript）

SlowMate AI Travel Planner 的 Serverless 後端。前端是 `../slowmate/index.html`，部署在 GitHub Pages：
`https://samya-traveler.github.io/slowmate/`。

| Function | Route | Auth | 用途 |
|---|---|---|---|
| `planTrip` | `GET /api/plan` | anonymous | 查今日（台灣時間）剩餘名額 `{ remaining_quota }` |
| `planTrip` | `POST /api/plan` | anonymous | 白名單 → 資格（Email OTP 首次免費額度 / 序號）→ 每日 50 次 → Claude → 成功才核銷 |
| `sendOtp` | `POST /api/send-otp` | anonymous | 首次免費額度的 6 位數 Email 驗證碼 |
| `sendEmail` | `POST /api/send-email` | anonymous | 以 Resend 寄出 HTML 行程信 |
| `generateCode` | `POST /api/generate-code` | 程式內驗證：`?code=` / `x-functions-key` / `x-slowmate-secret` 擇一 | 給 Logic App 產生 `SLOW-XXXX-YYYY` 序號 |

## 資料表（Azure Table Storage，首次呼叫時自動建立）

- `DailyUsage`：PartitionKey `plan`（每日生成）/ `email`（每日寄信），RowKey 是台灣日期 `YYYY-MM-DD`，欄位 `usedCount`
- `UserProfiles`：PartitionKey `user`，RowKey 是 `encodeURIComponent(email)`，欄位 `free_quota_used`、`email_verified_at`、`generation_count`…
- `RedeemCodes`：PartitionKey `code`，RowKey 是序號，欄位 `is_used`、`used_at`、`used_by_email`、`portaly_order_id`…
- `EmailOtps`：PartitionKey `otp`，RowKey 是 `encodeURIComponent(email)`，欄位 `otp_hash`（不存明碼）、`expires_at`（10 分鐘）、`attempt_count`（最多 5 次）、`last_sent_at`（60 秒冷卻）、`send_day`/`send_count`（每信箱每日上限）

## 資格分流（POST /api/plan）

| 情況 | 行為 |
|---|---|
| 管理員白名單 | 免 OTP、免序號、不扣每日名額 |
| 只帶有效序號 | 免 OTP，直接核銷序號；若免費額度未用過，回傳 `free_quota_preserved: true` |
| 帶 `otp_code` 且免費額度未用過 | 驗證 OTP → 使用免費額度；若同時帶有效序號，序號不核銷並回傳 `code_preserved: true` |
| 免費額度已用過、沒有有效序號 | 402 `payment_required` |
| 免費額度未用過、沒帶 OTP 也沒帶序號 | 403 `otp_required`（前端改呼叫 `/api/send-otp`） |

OTP 錯誤會回 400，`error` 為 `invalid_otp`（附 `attempts_left`）、`otp_expired`、`otp_locked` 或 `otp_missing`。
OTP 只有在行程「成功生成」後才作廢；AI 生成失敗時，10 分鐘內可用同一組驗證碼重試。

`/api/send-otp` 會先擋拋棄式信箱（400 `disposable_email`，清單在 `shared/disposable.ts`，可用 `DISPOSABLE_EXTRA_DOMAINS` 追加）。
若該信箱已用過免費額度，會直接回 402、不寄信；今日全站名額已滿時回 429、不寄信。驗證信與行程信共用 `EMAIL_DAILY_CAP`。

所有計數與核銷都使用 ETag 樂觀鎖。POST `/api/plan` 的流程是：

1. 先預扣一席名額。
2. 以 `lease_until` 暫時鎖住序號或免費資格，此時 `is_used` 仍為 `false`。
3. 呼叫 Claude。
4. 成功才寫入 `is_used: true`；失敗則釋放租約並退回名額，不會耗損資格。

回應碼：

| 狀態碼 | 意義 |
|---|---|
| 200 | 成功 |
| 400 | `invalid_input` 或 `invalid_code` |
| 402 | `payment_required` |
| 409 | 同一資格正在另一個視窗生成中 |
| 429 | `token_limit_reached` |
| 502 / 504 | AI 生成失敗（已全數回滾） |

## AI 模型

透過 Azure AI Foundry 的 Anthropic Messages 端點（`https://<resource>.services.ai.azure.com/anthropic/v1/messages`），以 REST 呼叫：

- 使用 `x-api-key` 與 `anthropic-version: 2023-06-01` 標頭。
- 以 `output_config.format`（JSON Schema structured outputs）強制輸出合法 JSON。
- 後端仍會清除 ```json 標籤，並以 `shared/trip.ts` 驗證與清洗結果。

> Claude 3.5 系列已全數退役，因此預設部署名稱為 `claude-sonnet-5-5`。請在 Foundry 部署 Claude 後，把 `CLAUDE_DEPLOYMENT_NAME` 設為你的部署名稱。
> 若部署的模型不支援 `effort` 或 structured outputs，可將 `CLAUDE_EFFORT=none`、`CLAUDE_STRUCTURED_OUTPUT=false`。

## 環境變數（Function App → 設定 → 環境變數）

完整清單見 `local.settings.example.json`。必填項目：

| 變數 | 說明 |
|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | 可省略，省略時改用 `AzureWebJobsStorage` |
| `AZURE_FOUNDRY_ENDPOINT`、`AZURE_FOUNDRY_API_KEY`、`CLAUDE_DEPLOYMENT_NAME` | Foundry 連線設定 |
| `RESEND_API_KEY`、`RESEND_FROM` | `RESEND_FROM` 須為 Resend 已驗證網域 |
| `GENERATE_CODE_SECRET` | 與 Logic App 共用的長隨機字串（也作為 OTP 雜湊的預設 pepper） |
| `OTP_SECRET` | OTP 雜湊用的 pepper，建議另設一組長隨機字串 |
| `ALLOWED_ORIGINS` | 預設 `https://samya-traveler.github.io` |

選填項目：

| 變數 | 預設值 |
|---|---|
| `DAILY_GLOBAL_LIMIT` | 50 |
| `ADMIN_EMAILS` | `sufuf3149@gmail.com` |
| `EMAIL_DAILY_CAP` | 95（Resend 免費方案每日 100 封） |
| `PORTALY_URL` | — |
| `CLAUDE_EFFORT` | `low` |
| `CLAUDE_TIMEOUT_MS` | 120000 |
| `OTP_MAX_SENDS_PER_DAY` | 5（同一信箱每日最多寄送驗證碼次數） |
| `DISPOSABLE_EXTRA_DOMAINS` | 空（逗號分隔的額外免洗網域） |
| `GENERATE_CODE_FUNCTION_KEY` | 空（想沿用 Azure Function Key 時，把它的值貼在這裡） |

## 本機開發與部署

```bash
cd api
npm install
cp local.settings.example.json local.settings.json   # 填入金鑰
npx azurite-table --inMemoryPersistence &             # 本機 Table Storage
npm start                                             # = build + func start
```

部署：`npm run build && func azure functionapp publish <your-function-app>`，需要 Node 20 以上與 Functions runtime v4。

部署後請完成以下設定：

- **CORS**：在 Function App → API → CORS 加入 `https://samya-traveler.github.io`。
- **前端**：把 `slowmate/index.html` 內的 `API_BASE_URL` 改成 `https://<your-function-app>.azurewebsites.net/api`。
- **GitHub Pages**：將 `slowmate/` 資料夾複製到 `Samya-Traveler.github.io` repo 的根目錄。根目錄的 `index.html` 不需要更動。

## Logic App 串接 generateCode

觸發條件：收到 Portaly 贊助通知信。接著加入一個 HTTP 動作，設定如下：

- **Method**：`POST`
- **認證（擇一即可）**：
  - URI 加上 `?code=<金鑰>`，或 Header `x-functions-key: <金鑰>`
  - Header `x-slowmate-secret: <金鑰>`

  金鑰需等於 App Setting 的 `GENERATE_CODE_SECRET` 或 `GENERATE_CODE_FUNCTION_KEY`；兩者都沒設定時一律拒絕。
  此端點已改為 `anonymous` 並在程式內驗證，因為 Azure 平台層的 Function Key 檢查無法做到「擇一」。程式讀不到平台產生的 Function Key，要沿用它請把值貼到 `GENERATE_CODE_FUNCTION_KEY`。
- **Body**：

  ```json
  { "sponsor_email": "<從信件解析>", "sponsor_name": "...", "amount": 150, "currency": "TWD", "order_id": "<訂單編號>" }
  ```

函式行為：

- **重複贊助**：同一位贊助者第 2、3 次贊助時，只要 `order_id` 不同或沒提供，每次都會產生全新序號。只有傳入完全相同的 `order_id` 才會回傳同一組序號（`idempotent: true`），`portaly_order_id` 也接受為別名。
- **發信權責**：
  - 有 `RESEND_API_KEY`、有 `sponsor_email`、且 `notify !== false` → 由 Function 寄出序號信，回應 `delivery: "function"`。
  - 否則只回傳序號 JSON，回應 `delivery: "logic_app"`，由 Logic App 自行寄出。
