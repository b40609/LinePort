# 容量與資料保留政策

2026-10-09，v0.7.0。配對佇列、去重集合、輸出 ID、Telegram 收件、人工決策及日誌均會增長。配對與 Telegram JSONL 包含私人文字／身分 ID，受 DACL 保護但未加密；不可公開或雲端同步。

## 本版政策

| 資料 | 保留與上限 |
| --- | --- |
| 配對 JSONL | 保留首次基準、全部 seen、queued／media_queued、sending／uncertain、retry、sent 與回覆對照；單檔 16 MiB |
| Telegram 收件 | 保存後才推進 offset；選定來源累計 50,000 則，40,000 預警 |
| 每配對待送 | 最多 1,000 則；積壓留在來源紀錄，後續輪次補入，不直接捨棄 |
| 輸出 ID／人工決策 | 保留防回流及人工處理證據，沒有自動期限或刪除 |
| 已知紀錄合計 | 256 MiB，80% 預警；可用磁碟低於 64 MiB 停止收件／發送 |
| 網頁預覽 | 最多 5,000 則，重新整理清空；不影響持久資料 |
| 私人封存 | 停止後複製已知資料，排除憑證，保存 manifest 與 SHA-256；原檔保留，封存不釋放容量 |
| 安全壓縮（v1.2.0） | 停止後先封存，再以驗證過的精簡紀錄逐檔取代；保留全部 seen、佇列、不明發送、回覆對照與最近 500 則原文 |

容量預檢先於 Telegram 更新確認與平台發送。超過單檔讀取上限、損壞、寫入失敗及結果不明保守停止；錯誤會說明影響及備份／核對下一步。不提供自動清空、循環覆寫或只保留最近幾天的去重。

封存 hash 使用串流；載入紀錄仍會建立去重與 ID 對照集合。檔案／數量限制不是精準記憶體配額；也不涵蓋任意未知檔案、全部登入儲存或封存目錄的總成長。不要把本版當成無限期聊天儲存系統。

## 安全壓縮（v1.2.0）

「設定與診斷 → 停止後安全壓縮紀錄」（`compaction.mjs`、`POST /api/storage/compact`，需停止轉送並勾選確認）依原設計五步執行：

1. **先備份**：呼叫既有私人封存，複製全部已知紀錄並驗證 SHA-256 manifest。封存永遠保留，壓縮工具不刪任何封存。
2. **候選快照**：在新的 `lineport-compact-<uuid>` 目錄產生精簡紀錄並 fsync。
   - 配對紀錄：一列路線識別、一列基準（合併全部已處理且不需另行保存的 seen ID）、全部未送佇列（含媒體 payload 與回覆來源）、全部 sending／uncertain 證據（人工決策檔原樣保留，仍能對上）、尚未到期的 retry 期限，以及全部已確認的目的 ID 對照（回覆對照）。最近 500 則已送出的原文保留原樣，更早的只留佔位文字，原文在封存裡。
   - 輸出 ID：去除重複列。
   - Telegram 收件：保留 offset，以及任一條讀取該聊天室的路線尚未處理的訊息；已被所有相關路線處理（或早於路線首次啟動）的才移除。沒有任何路線的聊天室全部保留。
3. **語意驗證**：重新解析候選與原檔，比對 seen 集合、佇列（含順序與 payload）、未解決 ID、回覆對照、retry 期限、輸出 ID 與收件 offset；任何不一致就中止，原資料不動。再核對候選檔的 SHA-256。
4. **逐檔原子切換**：每檔切換前重新確認原檔大小與修改時間未變，再以同磁碟的 rename 取代。每個精簡檔單獨都語意完整，所以中途中斷也只是部分檔案已精簡、其餘維持原樣，兩者都可讀。
5. 原檔保存在第 1 步的封存，不另外刪除；要釋放磁碟空間請自行確認後手動處理封存資料夾。

壓縮降低的是本程式計算的已知紀錄容量（單檔 16 MiB、合計 256 MiB），磁碟實際用量會因封存而暫時增加。

## SQLite（node:sqlite WAL）評估：本版不遷移

2026-11-23 在本機 Node v26.4.0 實測 `node:sqlite` 可開啟資料庫並切換 `journal_mode=wal`（SQLite 3.53.2），載入時沒有實驗性警告。仍決定本版不遷移，理由：

- 現有 JSONL 的安全性來自「每列 fsync 後才推進」與「載入時嚴格解析、不完整末行即停止」，已有大量測試覆蓋；換成 SQLite 要重寫全部持久層與失敗模式測試（寫入失敗、中止、損壞、多程序），風險高於本版目標。
- 打包內建的 Node 版本與 `node:sqlite` 在安裝版、可攜版的可用性需逐一驗證（待驗證）；降版的舊程式無法讀 SQLite，需要雙寫或匯出工具。
- 安全壓縮已解決「撞到 16 MiB／256 MiB 上限」的近期問題。

若日後遷移，建議步驟：一個資料庫檔、每配對一張 seen 表（主鍵 ID）與一張事件表；啟動時從 JSONL 一次匯入並以本版的語意比對驗證；遷移後保留 JSONL 為唯讀封存；交易內寫入取代逐列 fsync，`synchronous=FULL`；以單一程序鎖避免多份轉送同時開啟。

SHA-256 驗證只證明複本與清單一致，不是來源身分驗證或完整備份。CLI 僅唯讀核對；不提供還原封存覆寫真實資料的按鈕。

## LINE 登入憑證 DPAPI 評估：本版不實作

2026-11-23 讀過 `@rikaidev/yomi` 0.5.0 的 `dist/auth/credential-store.js`、`dist/line/core/service.js`、`dist/util/data-dir.js`。

**現況**：Windows 上 Yomi 把 LINE 登入（auth token、certificate、refresh token、mid、自己的 E2EE NaCl 金鑰對）存成一個明文 JSON：`%APPDATA%\yomi\line-credentials.json`。旁邊的 `line-e2ee-cache.json` 只放對方公鑰等可重算快取。LinePort 沒有設定 `YOMI_DATA_DIR`，所以這個目錄和使用者另外安裝的 Yomi MCP／Yomi Desktop 共用。

**可行的切入點**：`LineProtocolService` 接受 `options.credentialStore`，可以注入繼承 `CredentialStore` 的子類別，覆寫 `readPersistedBlob`／`persistBlob`，用 CurrentUser DPAPI 加解密（沿用 `dpapi.mjs`，換專用 entropy）。不需要修改 node_modules。

**本版不實作的原因**：

- **兩個程序共用同一檔**：本機頁（18765）與轉送程序（18766）各自 `new LineProtocolService()`。換 token 時 `save(mutatePersisted)` 每次都重讀磁碟以合併另一程序的寫入。兩邊必須同時升級成同一格式，任一邊（含 `versions\` 裡的舊版、watchdog 啟動的舊版）讀到密文都會當成沒有登入。
- **降版或與 Yomi 共用即失效**：舊版 LinePort 與 Yomi MCP／Desktop 只會讀明文 JSON。讀到密文時，`hydrateCacheFromBlob` 會得到空的工作階段，需要重新掃 QR。自己的 E2EE 金鑰對一旦遺失，新登入會產生新金鑰，舊群組金鑰與歷史訊息可能無法再解密（待驗證）。
- **Yomi 的寫入本身不是原子操作**：`persistBlob` 直接 `writeFile`，失敗只印 `console.error`。加密後若在寫到一半時中斷，連「人工修復 JSON」都不可能，必須另外做暫存檔、fsync、更名與備份，等於重寫一份憑證儲存。
- **效益有限**：DPAPI CurrentUser 擋不住同一使用者的惡意程式（它們同樣能呼叫 DPAPI），主要只防離線複製磁碟或備份。資料目錄已經限制只有目前使用者與 SYSTEM 可讀。
- 每次讀取都要啟動一次 PowerShell 解密（約 0.3–1 秒，未實測精確值），會發生在 `resumeSession` 與換 token 的關鍵路徑上。

**日後要做的建議步驟**：

1. 先把 LinePort 的 Yomi 資料目錄改到 `%LOCALAPPDATA%\LinePort\yomi`（設定 `credentialPath`），與 Yomi 本體分開。首次啟動時複製舊檔，並保留原檔。
2. 注入 DPAPI 子類別：寫入時先寫暫存檔、fsync 再更名；讀取時用快取的 mtime 減少解密次數；兩個程序同版才啟用，並在檔頭標記 `{"lineport":"dpapi-v1"}`。
3. 遷移時保留明文 `.bak` 到使用者確認新登入可用（成功接收一則訊息）。降版保護沿用現有的 autostart 降版檢查，讓舊版拒絕啟動，而不是把密文誤判為未登入。
4. 補測試：兩程序交錯換 token、寫入中斷、密文損壞、換 Windows 使用者、降版。全部用暫存目錄與假 DPAPI。
