# UIX 接手說明與待辦

- 作者：PeterChang
- 最後修改：2026-10-12 01:53

顏色說明：<span style="color:#1a7f37"><b>綠色</b></span>是好消息或已完成，<span style="color:#cf222e"><b>紅色</b></span>是問題或風險，<span style="color:#0969da"><b>藍色</b></span>是關鍵數字或決定。

這份是給「換一台電腦接著做」用的。開新的 Claude Code 對話時，先請它讀這份檔案和 `.claude/skills/peter-working-habits/SKILL.md`。

## 現在做到哪

- 版本 <span style="color:#0969da"><b>0.4.0</b></span>，功能都能用
- <span style="color:#1a7f37"><b>98 項單元測試、17 項瀏覽器實測全部通過</b></span>
- 在 602 個真實網頁上量過，九成能把風格完整套上去（這是 0.2 版量的，之後的修正還沒重量）
- <span style="color:#cf222e"><b>還沒用 git 存起來，也還沒推上 GitHub</b></span>

## 換電腦後怎麼接手

1. 安裝 Node.js 20 以上（Mac：`brew install node`）
2. 在專案資料夾執行：
   ```sh
   npm install
   npx playwright install chromium
   npm test            # 單元測試，應該 98 項全過
   npm run test:e2e    # 瀏覽器實測，應該 17 項全過
   npm run build       # 產生 dist/
   ```
3. 在 Chrome 打開 `chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `dist/chrome`
4. 隨便開一個網站，按 U 開面板

<span style="color:#cf222e"><b>不要直接載入專案根目錄</b></span>，裡面的 `node_modules` 會讓 Chrome 拒絕載入。

## 待辦（照建議順序）

### 1. 用 git 存起來並推上 GitHub（約 10 分鐘）

- <span style="color:#cf222e"><b>最優先</b></span>：現在所有東西都只在一台電腦上
- `git init` → 第一次 commit → `gh auth login` → 建立<b>私人</b>儲存庫並推上去
- `bench/results/` 這次刻意放進 git（約 9MB），因為人工檢查的標記結果沒辦法重新產生

### 2. 自己在 Chrome 上試用一次（約 5 分鐘）

- 到現在都是自動測試在跑，<b>還沒有人實際操作過</b>
- 留意：面板好不好用、哪個風格看起來怪、有沒有網站被弄壞

### 3. 元件樣式包（約 1 到 2 小時）

- <span style="color:#0969da"><b>讓「選好就能交付」真正成立的關鍵</b></span>
- 現在只匯出顏色、圓角這些數值，工程師還要自己寫按鈕、輸入框怎麼用這些數值
- 做法：從 `styles/app.css` 拿出已經測試過的元件規則，拿掉只有擴充功能才需要的部分（例如 `html[data-uix-theme]` 開頭、`!important`），加成第四種匯出格式

### 4. 深色風格下，深色圖示看不見（約 30 到 60 分鐘）

- <span style="color:#cf222e"><b>已知問題</b></span>：網站把圖示顏色寫死成深色，背景變黑後就看不到。玩具網站 funbox.com.tw 在 Dark 風格只剩 45% 圖示看得見（原網站 87%）
- 建議做法：找出「單色、而且是深色」的小圖示，在深色風格下把它反白；彩色 logo 不動
- 新的圖示檢查指標已經做好（`bench/measure.js` 的 `iconVisible`），可以直接用來驗證

### 5. 重跑完整量測（約 1.5 小時，加上人工標記 15 分鐘）

- 報告裡的數字是修正前量的，這次修了導覽列品牌色、網站強制顏色（C1）、字型開關，數字應該會變好
- 這次要用的新做法：
  - 人工檢查優先挑有深色導覽列的網站：`bench/audit-sample.js --enrich <網域清單.json>`
  - 找第二個人一起標記：`node bench/audit-server.js --rater <名字>`，報告會自動算兩人一致程度
  - 截圖已經改成拍三個螢幕高度，跟自動檢查的範圍一致
- 跑完更新 `docs/coverage-report.md` 和 `docs/decision-story.md` 的數字

### 6. 要不要把 C1 改成可選（約 20 分鐘，<span style="color:#0969da"><b>需要先決定</b></span>）

- C1 讓 UIX 蓋得過網站的強制顏色，但安裝時 Chrome 會多顯示「讀取和變更你在所有網站上的資料」
- 實際能碰到的範圍沒變，只是提示比較嚇人
- 如果在意安裝意願，可以改成預設關閉、需要時再打開（用 `chrome.permissions.request` 要權限）

### 7. 之後再說

- 比稿紀錄頁：自動截幾種風格並排，讓客戶確認選哪一個（約 1 到 2 小時）
- 匯出 Figma（Tokens Studio）格式，給設計師用（約 30 分鐘）
- 強制顏色分析裡有 2 個網頁，原因是 UIX 自己的規則，但顏色對不上，還沒查（`bench/results/cascade.json`）
- 會擋自動化程式的網站還是量不到（大網站 8 個、一般網站 15 個、台灣網站 4 個），目前只能在最壞情況裡當成失敗計算

## 已經決定的事（不用重新討論）

- <span style="color:#0969da"><b>主要使用者是「接案時要跟客戶比稿的人」</b></span>，不跟 Dark Reader 搶閱讀市場
- 不用 popup，按 U 開、I 關；另外有 Alt+Shift+U，游標在 iframe 裡也能用
- 預設只換顏色；換字型是開關，預設關；強化模式才改元件形狀，而且會一起換字型
- 元件依實際使用比例分四層（資料來源：HTTP Archive 2024 原始資料表）
- 不能把設定寫死在程式裡：ID、按鍵、文字都從 `src/config.js` 或 `_locales/` 讀，測試會檢查
- <span style="color:#0969da"><b>C1 已經做了</b></span>：抽查 20 個網頁，83% 換不掉的字是網站用了強制寫法，超過事先定的六成門檻
- 自動檢查只代表「風格套得完不完整」，「有沒有弄壞網站」要靠人工檢查

## 檔案在哪

- `src/`：擴充功能程式（`config.js` 是所有設定的來源）
- `styles/app.css`：所有風格和元件規則
- `tests/`：單元測試；`bench/e2e.test.js`：瀏覽器實測
- `bench/`：真實網站量測、人工檢查、強制顏色分析的程式
- `bench/strata/`：抽到的網站名單（固定種子 20261011）；`tranco-top300.csv` 是大網站組用的排行榜前 300 名
- `bench/results/`：所有量測結果和人工標記
- `docs/`：報告、決策紀錄、這份待辦

## 注意

- <span style="color:#cf222e"><b>Claude 的記憶不會跟著專案走</b></span>：這台電腦上 Claude 記下的習慣存在 `~/.claude/`，換電腦就沒有了。專案裡的 `.claude/skills/peter-working-habits/SKILL.md` 是同樣內容的摘要，會跟著 git 走
- Tranco 排行榜每天更新。這次用的是 2026-10-11 下載的版本，抽到的名單已經存在 `bench/strata/`，不需要原始清單也能重跑同一批網站
- 量測程式會實際連線到幾百個網站，跑之前確認網路環境可以這樣做
