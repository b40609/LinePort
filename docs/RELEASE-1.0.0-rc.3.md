# v1.0.0-rc.3：登入自動啟動（安裝選項與頁面開關）

2026-10-22。此版把「登入 Windows 時自動啟動 LinePort」做成產品功能：安裝程式提供可取消的選項，頁面提供兩個獨立開關，預設啟用但不強制。仍以候選版發布；完整 Windows 重啟自動啟動、長時間運作及其他帳號／裝置組合尚未驗證。

## 下載與更新

- [Windows 安裝版 EXE](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.3/LinePort-v1.0.0-rc.3-Windows-x64-Setup.exe)：執行安裝程式，再由桌面 LinePort 捷徑啟動。內含 Node.js、.NET 與依賴套件，不需另外安裝執行環境。
- [Windows 免安裝 ZIP](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.3/LinePort-v1.0.0-rc.3-Windows-x64.zip)：全部解壓至新資料夾，雙擊 LinePort.exe；不能只搬走 EXE。免安裝版沒有安裝精靈選項，請在頁面「開機自動啟動」勾選。
- [原始碼 ZIP](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.3/LinePort-v1.0.0-rc.3.zip) 與 [SHA-256 校驗檔](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.3/SHA256SUMS.txt)。

支援 Windows 11 x64，EXE 尚未簽署數位憑證。安裝不要求管理員權限，每次使用新版本目錄；阻擋可辨識的降版，保留既有版本。新版啟動器會安全切換可辨識的舊服務，保留原登入身分、規則與轉送紀錄；更新後請確認規則並按「開始轉送」。若正在手機授權，完成後再更新。

建議維持預設安裝路徑；過長的自訂路徑可能超過 Windows 路徑限制而使安裝回復。免安裝 ZIP 也請解壓至較短路徑。

## 新增內容

- 安裝精靈新增「登入 Windows 時自動啟動 LinePort」工作，預設勾選、可取消；只記錄選擇，第一次啟動時才建立啟動項目。免安裝版略過此步驟，改用頁面開關。
- 頁面「開機自動啟動」提供兩個獨立開關：登入時啟動本機服務與介面、登入時自動開始轉送。設定即時生效，隨時可在此或 Windows 設定→應用程式→啟動中關閉。
- 啟動項目指向 `%LOCALAPPDATA%\LinePort\autostart-service.ps1` 與 `autostart-relay.ps1`，路徑不隨版本目錄變動，升級版本不需重建；腳本以隱藏視窗執行，不顯示命令列視窗。
- 自動轉送沿用已保存且啟用的規則，只轉送啟動後的新文字；LINE 登入失效時停在待授權，不會自行發送測試訊息，也不會把目的 Bot 的訊息加入來源。
- 偏好存於 `%LOCALAPPDATA%\LinePort\autostart.json`，只有兩個布林值，不含憑證、Token 或聊天室內容。
- 升級永不重新開啟：只有第一次（偏好檔不存在）才依安裝精靈的選擇初始化，之後一律以頁面開關為準。
- 解除安裝會移除兩個啟動捷徑與自動啟動相關腳本／偏好檔，不影響已保存的規則、登入資料與轉送紀錄。

## 沿用修正

- 沿用 rc.2 的 Bot 目的群組文字相容修補與多代金鑰恢復修補；詳見 [RELEASE-1.0.0-rc.2.md](RELEASE-1.0.0-rc.2.md)。

## 驗證範圍

原始碼與套件各 282 項測試通過、0 失敗／跳過，新增自動啟動偏好、腳本、捷徑建立與移除、API 與頁面開關測試。隔離安裝驗證安裝精靈預設勾選、首次啟動建立兩個啟動項目、頁面關閉後移除、同版修復與升級不覆寫使用者選擇、解除安裝清理檔案。實機登入 Windows 自動啟動與長時間運作仍待使用者驗證，不在此宣稱通過。

打包與隔離驗證紀錄見 [VERIFICATION.md](../yomi-probe/VERIFICATION.md)。

## 重新建置

開發環境需 Node.js／npm、.NET 10 SDK 與 Inno Setup 6.7.3；Inno 編譯器的 Languages 目錄需備有上游 ChineseTraditional.isl。先執行 `scripts/Build-Portable.ps1 -OutputDirectory <全新目錄>`，再執行 `scripts/Build-Installer.ps1 -PortableDirectory <免安裝目錄> -OutputDirectory <另一全新目錄> -IsccPath <ISCC.exe 路徑>`。兩個腳本都拒絕覆寫既有輸出目錄。
