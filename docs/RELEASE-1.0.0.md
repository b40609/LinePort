# LinePort v1.0.0 正式版發布說明

發布日期：2026-10-29

**LinePort v1.0.0** 正式版整合跨平台即時通訊路由、Telegram 話題專區（Forum Topics）、動態訊息模版引擎、複合與正則關鍵字篩選、超長訊息自動分段、Electron 獨立桌面視窗與系統匣常駐，並通過 Cloudflare `security-audit` 規範級防禦性安全審查與 308 項自動化驗證。

---

## 一、 下載與安裝指南

| 發行版本 | 適用對象與啟動方式 | 下載連結 |
| :--- | :--- | :--- |
| **Windows 安裝版 (`Setup.exe`)** | **推薦一般使用者**：免管理員權限一鍵安裝，內建 Node.js 與 .NET 執行環境，自動建立桌面捷徑與可選開機自啟，支援舊版平滑熱升級。 | [LinePort-v1.0.0-Windows-x64-Setup.exe](https://github.com/b40609/LinePort/releases/download/v1.0.0/LinePort-v1.0.0-Windows-x64-Setup.exe) |
| **Desktop 獨立桌面免安裝版 (`Desktop-Portable.zip`)** | **推薦重度桌面用戶**：OmniRoute 同款獨立原生視窗，解壓後雙擊 `LinePort.exe` 即可啟動，支援右下角系統匣（System Tray）縮小常駐與單一實例鎖定。 | [LinePort-v1.0.0-Desktop-Portable-x64.zip](https://github.com/b40609/LinePort/releases/download/v1.0.0/LinePort-v1.0.0-Desktop-Portable-x64.zip) |
| **Windows 標準免安裝版 (`Windows-x64.zip`)** | **綠色環境部署**：完整解壓至新資料夾後雙擊 `LinePort.exe` 啟動本機服務並開啟控制台。 | [LinePort-v1.0.0-Windows-x64.zip](https://github.com/b40609/LinePort/releases/download/v1.0.0/LinePort-v1.0.0-Windows-x64.zip) |
| **原始碼與雜湊校驗** | 供應鏈完整性驗證與自行建置。 | [原始碼 ZIP](https://github.com/b40609/LinePort/releases/download/v1.0.0/LinePort-v1.0.0.zip) · [SHA256SUMS.txt](https://github.com/b40609/LinePort/releases/download/v1.0.0/SHA256SUMS.txt) |

---

## 二、 v1.0.0 核心新功能與架構升級

### 1. 獨立原生桌面客戶端與系統匣（System Tray）常駐
- 新增 Electron 獨立桌面包裝（`electron/main.cjs`），提供與 OmniRoute 一致的原生應用體驗，無需依賴外部瀏覽器分頁。
- **Close-to-Tray 背景常駐**：點擊視窗右上角關閉按鈕時自動收合至 Windows 右下角系統匣，背景訊息轉送持續運作不中斷。
- **單一實例鎖定（Single Instance Lock）**：重複點擊捷徑或執行檔時自動喚醒並聚焦既有視窗，杜絕多開衝突。

### 2. 動態訊息模版引擎（Dynamic Message Templating）
- 「訊息前綴／格式模版」欄位全面升級支援動態變數插值（`text-template.mjs`）：
  - `{source}`：來源聊天室名稱。
  - `{sender}`：發訊者顯示名稱（優先套用本機自訂別名 → 平台原始名稱 → 固定 ID）。
  - `{date}`：台北時區日期（`YYYY-MM-DD`）。
  - `{time}` / `{timeShort}`：台北時區時間（`HH:mm:ss` / `HH:mm`）。
  - `{text}`：原始訊息內文。
- 向後相容既有純文字前綴設定，設定頁規則模擬器支援即時預覽變數展開結果。

### 3. 進階關鍵字過濾：複合 AND 邏輯與 Regex 正規表達式
- **單行複合條件（AND 邏輯）**：支援以 `+` 或 `AND` 串聯多個必要詞彙（例如 `2330 + 買進` 或 `台積電 AND 目標價`），同則訊息須同時命中所有詞彙才轉發。
- **正規表達式（Regex）**：支援以 `/pattern/flags` 格式（例如 `/買進\s*\d{4}/i`）進行精準語法匹配，大幅過濾群組日常寒暄雜訊。
- **多行 OR 邏輯**：不同行之間維持「任一條件成立即轉送」，兼顧靈活性與嚴謹度。

### 4. Telegram 群組話題專區（Forum Topics）完整支援
- 支援將訊息精準投遞至開啟話題功能的 Telegram 超級群組指定子話題（`message_thread_id`）。
- 帳號頁支援自動探索近期活躍話題，並可手動綁定「聊天室 ID + 話題 ID + 自訂話題名稱」，持久化保存於 `%LOCALAPPDATA%\LinePort\lineport-telegram-topics.json`。
- 各話題擁有獨立待送佇列、去重紀錄與回覆引用對照，話題失效時安全暫停該路線，絕不誤發至群組預設大廳。

### 5. BMAD / CE 企業級韌性與高併發效能調優
- **超長訊息自動智慧分段（Smart Text Chunking）**：當單則訊息超過 Telegram（4,096 字元）或 Discord（2,000 字元）上限時，不再阻斷路線，自動優先於段落或換行處切分並標註 `(1/N)` 依序發送，全片段 ID 納入防回流保護。
- **Windows 原生斷線氣泡通知（BalloonTip）**：當 LINE 登入工作階段失效或遭伺服器端登出時，自動於桌面右下角彈出系統通知提醒重新授權（內建 30 秒防抖節流）。
- **高頻 I/O 快取與執行緒池加速**：`storage-health.mjs` 磁碟空間檢查（`statfs`）導入 10 秒安全水位快取，減少 99% 磁碟系統呼叫；預設開啟 `UV_THREADPOOL_SIZE=16` 提升多來源並行吞吐量。

### 6. Cloudflare Security-Audit 規範級資安加固
- 通過 Cloudflare 開源安全審查框架完整稽核：
  - **外部連結協定白名單**：桌面端 `setWindowOpenHandler` 與 `will-navigate` 強制檢驗 URL Scheme，僅放行 `http:` 與 `https:`。
  - **子程序防注入清理**：Windows 系統通知嚴格過濾換行符與 PowerShell 保留字元，並限制通知長度 <= 200 字元。
  - **切片收斂與 ReDoS 邊界防護**：切片演算法強制單步正推進，正則匹配限制 Pattern 長度 <= 256 字元、測試取樣 <= 20,000 字元。

---

## 三、 升級與相容性須知

- **平滑升級**：直接執行新版 `Setup.exe` 或解壓新版免安裝包啟動 `LinePort.exe`，啟動器會自動驗證舊版程序身分、安全停止轉送並完成熱切換。
- **資料完整保留**：既有登入憑證、E2EE 金鑰鏈、Telegram/Discord Token（含 Windows DPAPI 保護）、轉送規則、發訊者別名與歷史去重紀錄 100% 沿用。
- **自動化驗證**：原始碼與打包內附執行環境均通過 **308 項單元與整合測試（308 pass, 0 fail）**。
