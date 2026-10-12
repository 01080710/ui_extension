# UIX 接手說明與待辦

- 作者：PeterChang
- 最後修改：2026-10-12 10:12

顏色說明：<span style="color:#1a7f37"><b>綠色</b></span>是好消息或已完成，<span style="color:#cf222e"><b>紅色</b></span>是問題或風險，<span style="color:#0969da"><b>藍色</b></span>是關鍵數字或決定。

這份是給「換一台電腦接著做」用的。開新的 Claude Code 對話時，先請它讀這份檔案和 `.claude/skills/peter-working-habits/SKILL.md`。

## 現在做到哪

- 版本 <span style="color:#0969da"><b>0.4.0</b></span>，風格切換和 Token 匯出都能用
- <span style="color:#1a7f37"><b>已經推上 GitHub</b></span>（`01080710/ui_extension`）
- <span style="color:#cf222e"><b>這個儲存庫目前是公開的</b></span>（沒登入也打得開），原本的計畫是私人。裡面有決策紀錄和人工檢查的截圖，要不要改成私人需要我決定
- 新做好「元件樣式包」：在客戶網站上按一下，AI 就把目前畫面做成一個能跑的前端專案（.zip）
- <span style="color:#cf222e"><b>元件樣式包還沒 commit，也還沒有人在 Chrome 上實際用過，也還沒接過真的 Claude API</b></span>
- 測試：<span style="color:#1a7f37"><b>擴充功能 121 項、本機服務 28 項全部通過</b></span>
- 17 項瀏覽器實測是加元件樣式包之前跑的，之後還沒重跑
- 在 602 個真實網頁上量過，九成能把風格完整套上去（這是 0.2 版量的，之後的修正還沒重量）

## 元件樣式包怎麼運作（白話版）

1. 按 U 開面板，按「元件樣式包」
2. UIX 把目前畫面（大約兩個螢幕高）整理成一份精簡資料，交給<b>我電腦上的一個小服務</b>
3. 小服務去問 Claude，Claude 建議要用什麼框架、圖片字型怎麼處理，並列出它不確定、需要我回答的問題（最多 3 題）
4. 面板顯示三張卡片，已經依建議和我上次的選擇填好；沒問題就按「確認並生成」
5. Claude 寫出整個專案，小服務檢查過檔案安全後打包成 .zip，瀏覽器自動下載

<span style="color:#0969da"><b>Claude 的金鑰只放在那個小服務裡，擴充功能完全碰不到</b></span>。小服務只聽自己這台電腦的連線，而且只接受帶著通關密語（LOCAL_TOKEN）、又確實來自 UIX 的請求。

## 換電腦後怎麼接手

1. 安裝 Node.js 20.6 以上（Mac：`brew install node`）
2. 擴充功能：
   ```sh
   npm install
   npx playwright install chromium
   npm test            # 單元測試，應該 121 項全過
   npm run test:e2e    # 瀏覽器實測，原本 17 項全過（加元件樣式包後還沒重跑）
   npm run build       # 產生 dist/
   ```
3. 在 Chrome 打開 `chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `dist/chrome`
4. 本機服務（要用元件樣式包才需要）：
   ```sh
   cd server
   npm install
   npm test            # 應該 28 項全過，用的是假的 Claude，不花錢
   cp .env.example .env
   ```
   打開 `server/.env` 填三個值：
   - `ANTHROPIC_API_KEY`：到 `platform.claude.com` → Settings → API Keys 建立。<b>API 和 Claude.ai 訂閱分開計費</b>，要先在 Billing 儲值，建議在 Limits 設每月上限
   - `LOCAL_TOKEN`：自己產生一串 24 字以上的亂碼（`.env.example` 裡有指令）
   - `EXTENSION_ORIGIN`：`chrome-extension://` 加上 `chrome://extensions` 上看到的 UIX ID
   
   然後 `npm start`，它會在 `127.0.0.1:8788` 等待連線
5. 隨便開一個網站，按 U 開面板。第一次用元件樣式包時，把 `LOCAL_TOKEN` 貼進卡片

<span style="color:#cf222e"><b>不要直接載入專案根目錄</b></span>，裡面的 `node_modules` 會讓 Chrome 拒絕載入。換電腦後擴充功能 ID 可能會變，`EXTENSION_ORIGIN` 要跟著改，不然小服務會拒絕連線。

## 待辦（照建議順序）

### 1. 把元件樣式包 commit 並推上去（約 5 分鐘）

- <span style="color:#cf222e"><b>最優先</b></span>：這次新增的檔案都還只在這台電腦上
- `server/.env` 已經在 `.gitignore` 裡，不會被推上去；推之前還是用 `git status` 確認一次。儲存庫是公開的，<b>金鑰一旦推上去就要當成外洩，立刻到 Claude 後台停用</b>
- 推之前先決定儲存庫要不要改成私人（GitHub → Settings → Danger Zone → Change visibility）

### 2. 在 Chrome 上實際走一次，接真的 Claude（約 30 分鐘，加上 API 費用）

- 到現在都是自動測試在跑，<b>還沒有人實際操作過</b>，也<b>還沒接過真的 Claude</b>
- 要確認的三件事（目前都是待驗證的假設）：
  - 最順的情況下，是不是真的只要點 2 下
  - 解壓後 `npm install && npm run dev` 能不能直接跑起來
  - 跑起來的畫面跟原本網站看起來像不像
- 順便記下每次匯出實際花多少錢。我估一次大頁面約 <span style="color:#0969da"><b>0.4 到 0.5 美元</b></span>，這是照價目表算的，還沒實測
- 也要看一般操作有沒有被影響：選風格、套用、Token 下載和複製

### 3. 元件樣式包的瀏覽器實測（約 1 小時）

- 用假的 Claude 跑完整流程，不花錢，之後每次改程式都能自動檢查
- 要測：點 2 下完成、有沒填的卡片時按鈕擋得住、AI 追問後補答能繼續、真的下載到 .zip
- 同時重跑原本的 17 項，確認舊功能沒壞

### 4. 深色風格下，深色圖示看不見（約 30 到 60 分鐘）

- <span style="color:#cf222e"><b>已知問題</b></span>：網站把圖示顏色寫死成深色，背景變黑後就看不到。玩具網站 funbox.com.tw 在 Dark 風格只剩 45% 圖示看得見（原網站 87%）
- 建議做法：找出「單色、而且是深色」的小圖示，在深色風格下把它反白；彩色 logo 不動
- 新的圖示檢查指標已經做好（`bench/measure.js` 的 `iconVisible`），可以直接用來驗證

### 5. 重跑完整量測（約 1.5 小時，加上人工標記 15 分鐘）

- 報告裡的數字是修正前量的，之後修了導覽列品牌色、網站強制顏色（C1）、字型開關，數字應該會變好
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

- 版本號：元件樣式包驗證過以後，升到 0.5.0
- 要給別人用的話，本機小服務不夠（每個人都要自己裝、自己準備金鑰），要改成雲端服務加登入和用量限制。擴充功能這邊只要改 `src/config.js` 的 `PACK.server` 和驗證方式
- 打包用的 `archiver` 7 版底下帶了一個已停止維護的套件（`glob@10`）；8 版改成另一種模組寫法，要換的話本機服務要跟著改
- 圖片選「打包」時，小服務會去下載網頁上的圖片。內網位址、轉址、SVG 都擋了，但「查位址」和「真的下載」之間還有一個很短的空檔可以被利用。只給自己用可以接受，改成雲端服務前要補
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
- 元件樣式包：
  - <span style="color:#0969da"><b>Claude 金鑰只放在本機小服務，不放進擴充功能</b></span>；擴充功能裡只有背景程式會連網路，而且只連自己電腦
  - 新增一顆「元件樣式包」按鈕，原本的 Token 下載和複製不動
  - <b>不多要下載權限</b>，所以拿掉了「開啟資料夾」，完成後只顯示檔名
  - 只擷取目前畫面往下約兩個螢幕高，不加「選取區塊」的步驟，才能維持點 2 下
  - 預設用 `claude-sonnet-5-5`，可以在 `.env` 換
  - AI 回傳的檔案路徑只要有一個不安全（例如想寫到專案外面），整包作廢，不嘗試修正

## 檔案在哪

- `src/`：擴充功能程式（`config.js` 是所有設定的來源）
  - `pack-core.js`、`pack-capture.js`、`pack-ui.js`：元件樣式包的邏輯、擷取畫面、卡片介面
  - `background.js`：唯一會連網路的地方（只連本機小服務）
- `server/`：本機小服務（驗證連線、再精簡一次畫面資料、問 Claude、檢查檔案、打包）
- `styles/app.css`：所有風格和元件規則
- `tests/`：單元測試；`bench/e2e.test.js`：瀏覽器實測；`server/test/`：本機小服務的測試
- `bench/`：真實網站量測、人工檢查、強制顏色分析的程式
- `bench/strata/`：抽到的網站名單（固定種子 20261011）；`tranco-top300.csv` 是大網站組用的排行榜前 300 名
- `bench/results/`：所有量測結果和人工標記
- `docs/`：報告、決策紀錄、這份待辦

## 注意

- <span style="color:#cf222e"><b>Claude 的記憶不會跟著專案走</b></span>：這台電腦上 Claude 記下的習慣存在 `~/.claude/`，換電腦就沒有了。專案裡的 `.claude/skills/peter-working-habits/SKILL.md` 是同樣內容的摘要，會跟著 git 走
- 兩個本機服務的連接埠不一樣：人工檢查介面是 8787，元件樣式包的小服務是 8788，可以同時開
- 元件樣式包會把畫面上看得到的文字和圖片網址送給 Anthropic；表單裡填的內容、連結網址、網址後面的參數不會送出。拿客戶網站示範前要先跟客戶講好
- Tranco 排行榜每天更新。這次用的是 2026-10-11 下載的版本，抽到的名單已經存在 `bench/strata/`，不需要原始清單也能重跑同一批網站
- 量測程式會實際連線到幾百個網站，跑之前確認網路環境可以這樣做
