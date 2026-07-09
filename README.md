# 樂天小熊Samya 🧸｜Instagram Reels 高質感慢旅腳本產生系統

這個 repo 是一套可重複使用的 Reels 腳本產生系統：品牌人設與輸出規則固定寫死在
`prompts/system_prompt.md`，之後每次只要換「目的地／素材」，就能透過 CLI 或
網頁介面自動產出符合格式的腳本，不需要每次重寫 prompt。

## 系統組成

```
prompts/system_prompt.md   核心大腦：品牌人設 + 演算法優化規則 + 輸出格式（Master System Prompt）
scripts/lib/generator.py   共用邏輯：讀取 system prompt、組 user message、呼叫 Claude API
scripts/generate_script.py 命令列工具（CLI）
webapp/                    簡易網頁介面（Flask），適合非工程背景的人重複使用
examples/                  範例輸出，示範系統會產出什麼格式
outputs/                   CLI 產出的腳本預設存放處（已加入 .gitignore，不會進版控）
```

## 安裝

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入你的 ANTHROPIC_API_KEY
export $(cat .env | xargs)
```

## 方式一：命令列（CLI）

```bash
python scripts/generate_script.py \
  --destination "宜蘭大同 - 玉蘭茶園秘境" \
  --material "茶園步道可俯瞰蘭陽平原雲海，山中有一間老宅改建的茶屋民宿，晨起採茶體驗" \
  --output outputs/宜蘭玉蘭茶園.md
```

參數說明：
- `--destination / -d`：目的地或主題名稱（必填）
- `--material / -m`：素材文字，也可用 `--material-file` 從檔案讀取長文字
- `--style-notes / -s`：本次額外的風格備註（選填，例如「這次想強調親子友善」）
- `--output / -o`：輸出檔案路徑（不填則直接印在終端機）
- `--dry-run`：不呼叫 API，只印出最終組合的 system/user prompt，方便除錯或人工複製貼上到其他 AI 工具

## 方式二：網頁介面（適合重複、非工程背景使用）

```bash
python webapp/app.py
```

開啟 `http://127.0.0.1:5000`，填入目的地與素材，按下「產生腳本」即可，介面會直接顯示產出結果。

## 修改品牌規則

所有的人設、演算法權重、輸出格式規則都集中在 `prompts/system_prompt.md`。
未來如果要調整風格（例如口吻、Hook 類型、SEO 規則），只需要編輯這一份檔案，
CLI 與網頁介面會自動套用最新版本，不需要改程式碼。

## 範例輸出

參考 `examples/output_南投奧萬大.md`，可以看到系統實際會產出的三大區塊：
爆款 Hook 標題、分鏡腳本表格、社群引流文案與 SEO。
