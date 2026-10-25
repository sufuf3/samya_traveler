#!/usr/bin/env bash
# ============================================================================
# SlowMate 慢旅伴 — Azure 一鍵建置腳本
#
# 可在 Azure Cloud Shell (Bash) 或任何已安裝 az、node、npm、zip 的環境執行：
#   1. git clone https://github.com/sufuf3/samya_traveler.git && cd samya_traveler
#      git checkout claude/happy-pasteur-1pwfmx
#   2. bash api/deploy/setup-azure.sh
#
# 會建立 / 設定（已存在的資源會沿用，可重複執行）：
#   - Resource Group
#   - Storage Account（Table Storage：DailyUsage / UserProfiles / EmailOtps / RedeemCodes，首次呼叫時自動建表）
#   - Azure OpenAI 資源與 gpt-4.1 部署（金鑰自動讀取，不需手動複製）
#   - Function App（Flex Consumption，Node.js 22，Functions v4）
#   - App Settings（Gmail 應用程式密碼於執行時詢問，不會寫進檔案）、CORS
#   - 建置並以 zip deploy 部署 api/
#
# 事前需要（訂用帳戶層級，只需做一次，Service Principal 通常沒有權限）：
#   az provider register --namespace Microsoft.Web
#   az provider register --namespace Microsoft.CognitiveServices
#   az provider register --namespace Microsoft.Storage
#
# 不會建立：Logic App（Portaly 贊助通知信 → generateCode），見腳本最後的提示。
# ============================================================================
set -euo pipefail

# ---------- 可調整參數（也可用環境變數覆寫） ----------
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-9f34264e-d915-4f76-a3ff-cfccd30d8158}"
LOCATION="${LOCATION:-eastasia}"                 # Function / Storage 所在區域
AOAI_LOCATION="${AOAI_LOCATION:-eastus2}"        # Azure OpenAI 所在區域（需提供 gpt-4.1 Global Standard）
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-slowmate}"
APP_NAME="${APP_NAME:-slowmate-api}"             # 需全球唯一 → https://<APP_NAME>.azurewebsites.net
STORAGE_NAME="${STORAGE_NAME:-}"                 # 留空會沿用 / 自動產生（3~24 個小寫英數，需全球唯一）
AOAI_NAME="${AOAI_NAME:-}"                       # 留空會沿用 / 自動產生
AOAI_DEPLOYMENT="${AOAI_DEPLOYMENT:-gpt-4.1}"
AOAI_MODEL_VERSION="${AOAI_MODEL_VERSION:-2025-04-14}"
AOAI_CAPACITY="${AOAI_CAPACITY:-50}"             # 單位：千 tokens / 分鐘（Global Standard）
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://samya-traveler.github.io}"
NODE_VERSION="${NODE_VERSION:-22}"
GMAIL_USER="${GMAIL_USER:-littlebear.samya@gmail.com}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

say()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

# ---------- 0. 前置檢查 ----------
for bin in az node npm zip openssl; do
  command -v "$bin" >/dev/null || { echo "缺少 $bin，請改在 Azure Cloud Shell 執行或先安裝。" >&2; exit 1; }
done

say "切換訂用帳戶 $SUBSCRIPTION_ID"
az account show >/dev/null 2>&1 || az login --use-device-code
az account set --subscription "$SUBSCRIPTION_ID"
az account show --query "{name:name, id:id, user:user.name}" -o table

# ---------- 1. Gmail 應用程式密碼（不寫入任何檔案） ----------
if [[ -z "${GMAIL_APP_PASSWORD:-}" ]]; then
  say "Gmail 寄信設定"
  echo "寄件帳號：$GMAIL_USER（需開啟兩步驟驗證，於 Google 帳戶 → 安全性 → 應用程式密碼 產生 16 碼密碼）"
  read -r -s -p "GMAIL_APP_PASSWORD（直接 Enter 可先跳過，稍後在 Portal 補上）: " GMAIL_APP_PASSWORD; echo
fi
GMAIL_APP_PASSWORD="$(printf '%s' "$GMAIL_APP_PASSWORD" | tr -d '[:space:]')"

# ---------- 2. Resource Group ----------
say "Resource Group：$RESOURCE_GROUP（$LOCATION）"
az group show -n "$RESOURCE_GROUP" -o none 2>/dev/null || az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

# ---------- 3. Storage Account ----------
if [[ -z "$STORAGE_NAME" ]]; then
  STORAGE_NAME="$(az storage account list -g "$RESOURCE_GROUP" --query "[?starts_with(name,'stslowmate')].name | [0]" -o tsv)"
  STORAGE_NAME="${STORAGE_NAME:-stslowmate$(openssl rand -hex 4)}"
fi
say "Storage Account：$STORAGE_NAME"
if ! az storage account show -n "$STORAGE_NAME" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az storage account create \
    -n "$STORAGE_NAME" -g "$RESOURCE_GROUP" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --allow-blob-public-access false -o none
fi
STORAGE_CONN="$(az storage account show-connection-string -n "$STORAGE_NAME" -g "$RESOURCE_GROUP" --query connectionString -o tsv)"

# ---------- 4. Azure OpenAI + gpt-4.1 ----------
if [[ -z "$AOAI_NAME" ]]; then
  AOAI_NAME="$(az cognitiveservices account list -g "$RESOURCE_GROUP" --query "[?kind=='OpenAI'].name | [0]" -o tsv)"
  AOAI_NAME="${AOAI_NAME:-aoai-slowmate-$(openssl rand -hex 3)}"
fi
say "Azure OpenAI：$AOAI_NAME（$AOAI_LOCATION）"
if ! az cognitiveservices account show -n "$AOAI_NAME" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az cognitiveservices account create \
    -n "$AOAI_NAME" -g "$RESOURCE_GROUP" -l "$AOAI_LOCATION" \
    --kind OpenAI --sku S0 --custom-domain "$AOAI_NAME" --yes -o none
fi
if ! az cognitiveservices account deployment show -n "$AOAI_NAME" -g "$RESOURCE_GROUP" --deployment-name "$AOAI_DEPLOYMENT" -o none 2>/dev/null; then
  say "部署 $AOAI_DEPLOYMENT（模型 gpt-4.1 / $AOAI_MODEL_VERSION，容量 ${AOAI_CAPACITY}K TPM）"
  if ! az cognitiveservices account deployment create \
        -n "$AOAI_NAME" -g "$RESOURCE_GROUP" --deployment-name "$AOAI_DEPLOYMENT" \
        --model-name gpt-4.1 --model-version "$AOAI_MODEL_VERSION" --model-format OpenAI \
        --sku-name GlobalStandard --sku-capacity "$AOAI_CAPACITY" -o none; then
    warn "以 ${AOAI_CAPACITY}K TPM 部署失敗（可能是配額不足），改用 10K TPM 重試"
    az cognitiveservices account deployment create \
      -n "$AOAI_NAME" -g "$RESOURCE_GROUP" --deployment-name "$AOAI_DEPLOYMENT" \
      --model-name gpt-4.1 --model-version "$AOAI_MODEL_VERSION" --model-format OpenAI \
      --sku-name GlobalStandard --sku-capacity 10 -o none
  fi
fi
AOAI_ENDPOINT="$(az cognitiveservices account show -n "$AOAI_NAME" -g "$RESOURCE_GROUP" --query properties.endpoint -o tsv)"
AOAI_KEY="$(az cognitiveservices account keys list -n "$AOAI_NAME" -g "$RESOURCE_GROUP" --query key1 -o tsv)"

# ---------- 5. Function App（Flex Consumption） ----------
say "Function App：$APP_NAME（Flex Consumption, Node.js $NODE_VERSION）"
if ! az functionapp show -n "$APP_NAME" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az functionapp create \
    -n "$APP_NAME" -g "$RESOURCE_GROUP" \
    --storage-account "$STORAGE_NAME" \
    --flexconsumption-location "$LOCATION" \
    --runtime node --runtime-version "$NODE_VERSION" -o none
fi

# ---------- 6. App Settings ----------
say "寫入 App Settings"
EXISTING_SETTINGS="$(az functionapp config appsettings list -n "$APP_NAME" -g "$RESOURCE_GROUP" --query "[].name" -o tsv)"
has_setting() { grep -qxF "$1" <<<"$EXISTING_SETTINGS"; }

SETTINGS=(
  "AZURE_STORAGE_CONNECTION_STRING=$STORAGE_CONN"
  "AZURE_OPENAI_ENDPOINT=$AOAI_ENDPOINT"
  "AZURE_OPENAI_API_KEY=$AOAI_KEY"
  "AZURE_OPENAI_DEPLOYMENT=$AOAI_DEPLOYMENT"
  "AZURE_OPENAI_API_VERSION=2025-01-01-preview"
  "AI_TIMEOUT_MS=120000"
  "GMAIL_USER=$GMAIL_USER"
  "MAIL_FROM_NAME=SlowMate 慢旅伴"
  "EMAIL_DAILY_CAP=400"
  "DAILY_GLOBAL_LIMIT=50"
  "VIP_POOL_LIMIT=30"
  "PORTALY_URL=https://portaly.cc/samya_traveler"
  "ALLOWED_ORIGINS=$ALLOWED_ORIGIN,http://localhost:1313"
  "SLOWMATE_APP_URL=$ALLOWED_ORIGIN/slowmate/"
  "OTP_MAX_SENDS_PER_DAY=5"
)
[[ -n "$GMAIL_APP_PASSWORD" ]] && SETTINGS+=("GMAIL_APP_PASSWORD=$GMAIL_APP_PASSWORD")
# 密鑰只在第一次產生，重跑時不覆蓋（避免 Logic App 的密鑰失效）
GENERATE_CODE_SECRET_NEW=""
if ! has_setting GENERATE_CODE_SECRET; then
  GENERATE_CODE_SECRET_NEW="$(openssl rand -hex 32)"
  SETTINGS+=("GENERATE_CODE_SECRET=$GENERATE_CODE_SECRET_NEW")
fi
has_setting OTP_SECRET || SETTINGS+=("OTP_SECRET=$(openssl rand -hex 32)")
# 管理員金鑰（取代舊的 Email 白名單）：前端 ?admin=1 →「🔐 慢旅伴戰情室」輸入一次；舊名 ADMIN_TOKEN 仍可使用
has_setting ADMIN_SECRET || has_setting ADMIN_TOKEN || SETTINGS+=("ADMIN_SECRET=$(openssl rand -hex 32)")

az functionapp config appsettings set -n "$APP_NAME" -g "$RESOURCE_GROUP" -o none --settings "${SETTINGS[@]}"
# 舊版的 Email 白名單已停用，確保不留在設定中
has_setting ADMIN_EMAILS && az functionapp config appsettings delete -n "$APP_NAME" -g "$RESOURCE_GROUP" --setting-names ADMIN_EMAILS -o none

# ---------- 7. CORS ----------
say "設定 CORS：$ALLOWED_ORIGIN、http://localhost:1313"
CURRENT_ORIGINS="$(az functionapp cors show -n "$APP_NAME" -g "$RESOURCE_GROUP" --query allowedOrigins -o tsv 2>/dev/null || true)"
for origin in "$ALLOWED_ORIGIN" "http://localhost:1313"; do
  grep -qxF "$origin" <<<"$CURRENT_ORIGINS" || az functionapp cors add -n "$APP_NAME" -g "$RESOURCE_GROUP" --allowed-origins "$origin" -o none
done

# ---------- 8. Build & zip deploy ----------
say "建置並部署 api/"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
cp -r "$API_DIR"/{package.json,package-lock.json,host.json,tsconfig.json,shared,planTrip,sendOtp,checkCode,sendEmail,generateCode,adminStats} "$BUILD_DIR"/
(
  cd "$BUILD_DIR"
  npm ci --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund
  rm -rf shared planTrip sendOtp checkCode sendEmail generateCode adminStats tsconfig.json
  zip -qr ../slowmate-api.zip .
)
az functionapp deployment source config-zip -n "$APP_NAME" -g "$RESOURCE_GROUP" --src "$BUILD_DIR/../slowmate-api.zip" -o none
rm -f "$BUILD_DIR/../slowmate-api.zip"

# ---------- 9. 驗證 ----------
API_BASE="https://$APP_NAME.azurewebsites.net/api"
say "檢查 GET $API_BASE/plan"
sleep 15
curl -sS --max-time 60 "$API_BASE/plan" || warn "第一次呼叫可能因冷啟動逾時，稍後再試：curl $API_BASE/plan"
echo

# ---------- 10. 後續步驟 ----------
cat <<EOF

============================================================
✅ Azure 資源與 API 已部署完成

API Base URL：$API_BASE
Azure OpenAI：$AOAI_ENDPOINT（部署 $AOAI_DEPLOYMENT）
EOF
if [[ -n "$GENERATE_CODE_SECRET_NEW" ]]; then
  cat <<EOF

【請妥善保存，之後只能在 Portal 的 Environment variables 查看】
  GENERATE_CODE_SECRET = $GENERATE_CODE_SECRET_NEW
  （Logic App 呼叫 generateCode 時放在 Header：x-slowmate-secret）
EOF
fi
[[ -z "$GMAIL_APP_PASSWORD" ]] && warn "尚未設定 GMAIL_APP_PASSWORD：請到 Portal → $APP_NAME → Environment variables 新增，否則無法寄送驗證碼與行程信。"
cat <<EOF

接下來請手動完成：
 1. 前端：把 slowmate/index.html 的 API_BASE_URL 改為
      $API_BASE
    再放到 Hugo repo 的 static/slowmate/index.html。
 2. Logic App：Portaly 通知信觸發 → HTTP POST
      $API_BASE/generateCode
    Header：x-slowmate-secret: <GENERATE_CODE_SECRET>
    Body：{ "sponsor_email": "...", "amount": 150, "order_id": "..." }
============================================================
EOF
