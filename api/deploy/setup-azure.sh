#!/usr/bin/env bash
# ============================================================================
# SlowMate 慢旅伴 — Azure 一鍵建置腳本
#
# 建議在 Azure Cloud Shell (Bash) 執行：已內建 az、func、node、git。
#   1. git clone https://github.com/sufuf3/samya_traveler.git && cd samya_traveler
#      git checkout claude/happy-pasteur-1pwfmx
#   2. bash api/deploy/setup-azure.sh
#
# 會建立：
#   - Resource Group
#   - Storage Account（Table Storage：DailyUsage / UserProfiles / RedeemCodes / EmailOtps，首次呼叫時自動建表）
#   - Function App（Flex Consumption，Node.js 22，Functions v4）
#   - App Settings（金鑰會在執行時詢問，不會寫進檔案）、CORS
#   - 部署 api/ 程式碼
#
# 不會建立（需在 Portal 手動完成，見腳本最後的提示）：
#   - Azure AI Foundry 的 Claude 模型部署
#   - Resend 寄件網域驗證
#   - Logic App（Portaly 贊助通知信 → generateCode）
#
# 可重複執行：已存在的資源會沿用。
# ============================================================================
set -euo pipefail

# ---------- 可調整參數（也可用環境變數覆寫） ----------
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-9f34264e-d915-4f76-a3ff-cfccd30d8158}"
LOCATION="${LOCATION:-eastasia}"                 # Function / Storage 所在區域
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-slowmate}"
APP_NAME="${APP_NAME:-slowmate-api}"             # 需全球唯一 → https://<APP_NAME>.azurewebsites.net
STORAGE_NAME="${STORAGE_NAME:-}"                 # 留空會自動產生（3~24 個小寫英數，需全球唯一）
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://samya-traveler.github.io}"
NODE_VERSION="${NODE_VERSION:-22}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

say()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

ask() { # ask VAR "提示" [default] [secret]
  local __var="$1" __prompt="$2" __default="${3:-}" __secret="${4:-}" __val=""
  if [[ -n "${!__var:-}" ]]; then return; fi   # 已由環境變數提供
  if [[ -n "$__secret" ]]; then
    read -r -s -p "$__prompt: " __val; echo
  else
    read -r -p "$__prompt${__default:+ [$__default]}: " __val
  fi
  printf -v "$__var" '%s' "${__val:-$__default}"
}

# ---------- 0. 前置檢查 ----------
for bin in az func node npm; do
  command -v "$bin" >/dev/null || { echo "缺少 $bin，請改在 Azure Cloud Shell 執行或先安裝。" >&2; exit 1; }
done

say "切換訂用帳戶 $SUBSCRIPTION_ID"
az account show >/dev/null 2>&1 || az login --use-device-code
az account set --subscription "$SUBSCRIPTION_ID"
az account show --query "{name:name, id:id, user:user.name}" -o table

# ---------- 1. 收集金鑰（不寫入任何檔案） ----------
say "請輸入設定值（直接 Enter 採用預設值；金鑰輸入時不會顯示）"
ask AZURE_FOUNDRY_ENDPOINT "Azure AI Foundry 端點（例 https://<resource>.services.ai.azure.com/anthropic）"
ask AZURE_FOUNDRY_API_KEY  "Azure AI Foundry API Key" "" secret
ask CLAUDE_DEPLOYMENT_NAME "Foundry 上 Claude 的部署名稱" "claude-sonnet-5-5"
ask RESEND_API_KEY         "Resend API Key（re_ 開頭）" "" secret
ask RESEND_FROM            "寄件者（需為 Resend 已驗證網域）" "SlowMate 慢旅伴 <slowmate@your-domain.com>"
ask ADMIN_EMAILS           "管理員白名單 Email（逗號分隔）" "sufuf3149@gmail.com"

GENERATE_CODE_SECRET="${GENERATE_CODE_SECRET:-$(openssl rand -hex 32)}"
OTP_SECRET="${OTP_SECRET:-$(openssl rand -hex 32)}"

# ---------- 2. Resource Group ----------
say "建立 Resource Group：$RESOURCE_GROUP（$LOCATION）"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

# ---------- 3. Storage Account ----------
if [[ -z "$STORAGE_NAME" ]]; then
  EXISTING_STORAGE="$(az storage account list -g "$RESOURCE_GROUP" --query "[?starts_with(name,'stslowmate')].name | [0]" -o tsv)"
  STORAGE_NAME="${EXISTING_STORAGE:-stslowmate$(openssl rand -hex 4)}"
fi
say "建立 Storage Account：$STORAGE_NAME"
if ! az storage account show -n "$STORAGE_NAME" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az storage account create \
    -n "$STORAGE_NAME" -g "$RESOURCE_GROUP" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --allow-blob-public-access false -o none
fi
STORAGE_CONN="$(az storage account show-connection-string -n "$STORAGE_NAME" -g "$RESOURCE_GROUP" --query connectionString -o tsv)"

# ---------- 4. Function App（Flex Consumption） ----------
say "建立 Function App：$APP_NAME（Flex Consumption, Node.js $NODE_VERSION）"
if ! az functionapp show -n "$APP_NAME" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  if ! az functionapp create \
        -n "$APP_NAME" -g "$RESOURCE_GROUP" \
        --storage-account "$STORAGE_NAME" \
        --flexconsumption-location "$LOCATION" \
        --runtime node --runtime-version "$NODE_VERSION" -o none; then
    warn "Flex Consumption 建立失敗（可能是 $LOCATION 尚未支援）。"
    warn "請改用支援的區域重跑，例如：LOCATION=southeastasia bash api/deploy/setup-azure.sh"
    exit 1
  fi
fi

# ---------- 5. App Settings ----------
say "寫入 App Settings"
az functionapp config appsettings set -n "$APP_NAME" -g "$RESOURCE_GROUP" -o none --settings \
  "AZURE_STORAGE_CONNECTION_STRING=$STORAGE_CONN" \
  "AZURE_FOUNDRY_ENDPOINT=$AZURE_FOUNDRY_ENDPOINT" \
  "AZURE_FOUNDRY_API_KEY=$AZURE_FOUNDRY_API_KEY" \
  "CLAUDE_DEPLOYMENT_NAME=$CLAUDE_DEPLOYMENT_NAME" \
  "CLAUDE_EFFORT=low" \
  "CLAUDE_STRUCTURED_OUTPUT=true" \
  "CLAUDE_TIMEOUT_MS=120000" \
  "DAILY_GLOBAL_LIMIT=50" \
  "ADMIN_EMAILS=$ADMIN_EMAILS" \
  "PORTALY_URL=https://portaly.cc/samya_traveler" \
  "ALLOWED_ORIGINS=$ALLOWED_ORIGIN" \
  "SLOWMATE_APP_URL=$ALLOWED_ORIGIN/slowmate/" \
  "RESEND_API_KEY=$RESEND_API_KEY" \
  "RESEND_FROM=$RESEND_FROM" \
  "EMAIL_DAILY_CAP=95" \
  "OTP_SECRET=$OTP_SECRET" \
  "OTP_MAX_SENDS_PER_DAY=5" \
  "GENERATE_CODE_SECRET=$GENERATE_CODE_SECRET"

# ---------- 6. CORS ----------
say "設定 CORS：$ALLOWED_ORIGIN"
CURRENT_ORIGINS="$(az functionapp cors show -n "$APP_NAME" -g "$RESOURCE_GROUP" --query allowedOrigins -o tsv 2>/dev/null || true)"
if ! grep -qxF "$ALLOWED_ORIGIN" <<<"$CURRENT_ORIGINS"; then
  az functionapp cors add -n "$APP_NAME" -g "$RESOURCE_GROUP" --allowed-origins "$ALLOWED_ORIGIN" -o none
fi

# ---------- 7. Build & Deploy ----------
say "建置並部署 api/"
pushd "$API_DIR" >/dev/null
npm ci
npm run build
func azure functionapp publish "$APP_NAME"
popd >/dev/null

# ---------- 8. 驗證 ----------
API_BASE="https://$APP_NAME.azurewebsites.net/api"
say "檢查 GET $API_BASE/plan"
sleep 10
curl -sS --max-time 60 "$API_BASE/plan" || warn "第一次呼叫可能因冷啟動逾時，稍後再試：curl $API_BASE/plan"
echo

# ---------- 9. 後續手動步驟 ----------
cat <<EOF

============================================================
✅ Azure 資源與 API 已部署完成

API Base URL：$API_BASE

【請妥善保存，不會再顯示】
  GENERATE_CODE_SECRET = $GENERATE_CODE_SECRET
  （Logic App 呼叫 generateCode 時放在 Header：x-slowmate-secret）

接下來請手動完成：
 1. 前端：把 slowmate/index.html 的 API_BASE_URL 改為
      $API_BASE
    再把 slowmate/ 資料夾放進 Samya-Traveler.github.io repo。
 2. Azure AI Foundry：確認 Claude 已部署，名稱與 CLAUDE_DEPLOYMENT_NAME（$CLAUDE_DEPLOYMENT_NAME）一致。
 3. Resend：驗證寄件網域（RESEND_FROM 的網域）。
 4. Logic App：Portaly 通知信觸發 → HTTP POST
      $API_BASE/generateCode
    Header：x-slowmate-secret: <上面的 GENERATE_CODE_SECRET>
    Body：{ "sponsor_email": "...", "amount": 150, "order_id": "..." }
 5. 測試序號產生：
      curl -X POST "$API_BASE/generateCode" \\
        -H "Content-Type: application/json" \\
        -H "x-slowmate-secret: $GENERATE_CODE_SECRET" \\
        -d '{"amount":88,"notify":false}'
============================================================
EOF
