# 樂天小熊Samya 🧸｜Instagram Reels 高質感慢旅腳本產生系統

這個 repo 是一套可重複使用的 Reels 腳本產生系統，包含兩種模式，品牌人設與輸出
規則固定寫死在對應的 prompt 檔案裡，之後每次只要換「目的地／素材」，就能透過
CLI 或網頁介面自動產出符合格式的腳本，不需要每次重寫 prompt：

- **發想模式 (ideation)**：從零開始，幫你想這支影片該拍什麼、Hook 標題、分鏡與文案。
- **剪輯導演模式 (edit)**：你已經有實拍素材，系統扮演剪輯導演，幫你決定排序、寫口播稿、字卡與音效建議。

## 系統組成

```
prompts/system_prompt.md         發想模式大腦：品牌人設 + 演算法優化規則 + 輸出格式
prompts/editor_system_prompt.md  剪輯導演模式大腦：排序 + 口播稿 + 字卡 + 音效建議
scripts/lib/generator.py         共用邏輯：依模式讀取對應 system prompt、組 user message、呼叫 Claude API
scripts/generate_script.py       命令列工具（CLI），用 --mode 切換兩種模式
webapp/                          簡易網頁介面（Flask），適合非工程背景的人重複使用，介面上可切換模式
examples/                        範例輸出，示範系統會產出什麼格式
outputs/                         CLI 產出的腳本預設存放處（已加入 .gitignore，不會進版控）
```

## 旅遊部落格（Samya Traveler）

`blog/` 是 Samya Traveler 旅遊部落格的完整 Hugo + PaperMod 網站原始碼，準備搬到
`Samya-Traveler/Samya-Traveler.github.io`，並透過 GitHub Actions 部署到 GitHub Pages。
建立 repo、設定 Pages、本機預覽與新增文章的步驟請見 [`blog/README.md`](blog/README.md)。

## 安裝

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入你的 ANTHROPIC_API_KEY
export $(cat .env | xargs)
```

## 方式一：命令列（CLI）

發想模式（預設）：

```bash
python scripts/generate_script.py \
  --destination "宜蘭大同 - 玉蘭茶園秘境" \
  --material "茶園步道可俯瞰蘭陽平原雲海，山中有一間老宅改建的茶屋民宿，晨起採茶體驗" \
  --output outputs/宜蘭玉蘭茶園.md
```

剪輯導演模式（已有實拍素材，貼上素材清單描述）：

```bash
python scripts/generate_script.py --mode edit \
  --destination "花蓮 - 池上慢旅" \
  --material "素材1：火車窗外緩慢倒退的稻田，有鐵軌框當聲
素材2：POV 手拿熱茶，背景山霧繚繞的陽台
素材3：兩人在步道散步的背影，陽光灑落" \
  --output outputs/花蓮池上_剪輯.md
```

參數說明：
- `--destination / -d`：目的地或主題名稱（必填）
- `--mode`：`ideation`（預設，從零發想）或 `edit`（剪輯既有素材成片）
- `--material / -m`：素材文字，也可用 `--material-file` 從檔案讀取長文字
- `--style-notes / -s`：本次額外的風格備註（選填，例如「這次想強調親子友善」）
- `--output / -o`：輸出檔案路徑（不填則直接印在終端機）
- `--dry-run`：不呼叫 API，只印出最終組合的 system/user prompt，方便除錯或人工複製貼上到其他 AI 工具

## 方式二：網頁介面（適合重複、非工程背景使用）

```bash
python webapp/app.py
```

開啟 `http://127.0.0.1:5000`，選擇模式（發想 / 剪輯導演）、填入目的地與素材，
按下「產生腳本」即可，介面會直接顯示產出結果。

## 修改品牌規則

所有的人設、演算法權重、輸出格式規則都集中在 `prompts/system_prompt.md`（發想模式）
與 `prompts/editor_system_prompt.md`（剪輯導演模式）。未來如果要調整風格（例如口吻、
Hook 類型、SEO 規則、口播稿語氣），只需要編輯對應的檔案，CLI 與網頁介面會自動套用
最新版本，不需要改程式碼。

## 範例輸出

參考 `examples/output_南投奧萬大.md`，可以看到系統實際會產出的三大區塊：
爆款 Hook 標題、分鏡腳本表格、社群引流文案與 SEO。
