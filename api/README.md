# SlowMate API（Azure Functions · Node.js v4 · TypeScript）

SlowMate AI Travel Planner 的 Serverless 後端。前端是 `../slowmate/index.html`，部署在 GitHub Pages：
`https://samya-traveler.github.io/slowmate/`。

| Function | Route | Auth | 用途 |
|---|---|---|---|
| `planTrip` | `GET /api/plan` | anonymous | 查今日（台灣時間）剩餘名額 `{ remaining_quota }` |
| `planTrip` | `POST /api/plan` | anonymous | 白名單 → 資格（免費試用 / 序號）→ 每日 50 次 → Claude → 成功才核銷 |
| `sendEmail` | `POST /api/send-email` | anonymous | 以 Resend 寄出 HTML 行程信 |
| `generateCode` | `POST /api/generate-code` | **function key** + `x-slowmate-secret` | 給 Logic App 產生 `SLOW-XXXX-YYYY` 序號 |

## 資料表（Azure Table Storage，首次呼叫時自動建立）

- `DailyUsage`：PartitionKey `plan`（每日生成）/ `email`（每日寄信），RowKey 是台灣日期 `YYYY-MM-DD`，欄位 `usedCount`
- `UserProfiles`：PartitionKey `user`，RowKey 是 `encodeURIComponent(email)`，欄位 `free_trial_used`、`generation_count`…
- `RedeemCodes`：PartitionKey `code`，RowKey 是序號，欄位 `is_used`、`used_at`、`used_by_email`、`portaly_order_id`…

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
| `GENERATE_CODE_SECRET` | 與 Logic App 共用的長隨機字串 |
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
- **URI**：`https://<app>.azurewebsites.net/api/generate-code?code=<function key>`
- **Headers**：`Content-Type: application/json`、`x-slowmate-secret: <GENERATE_CODE_SECRET>`
- **Body**：

  ```json
  { "sponsor_email": "<從信件解析>", "sponsor_name": "...", "amount": 150, "currency": "TWD", "portaly_order_id": "<訂單編號>" }
  ```

函式行為：

- 有 `sponsor_email` 時，會自動用 Resend 把序號寄給贊助者，回應中 `email_sent: true`。
- 若希望由 Logic App 自行寄信，請在 body 加入 `"notify": false`，再取用回應中的 `code`。
- 同一個 `portaly_order_id` 重送時，會回傳同一組序號（冪等），不會重複發號。
