# 安裝與第一次啟動

適用於目前的 Node.js 一般群組轉送工具。`src/` 的 C# 通知工具是早期實驗，不需要安裝 .NET、開啟開發人員模式或執行 `scripts/Build.ps1`。

## 1. 準備環境

- Windows 11、Node.js 與 npm。本專案實測版本為 Node.js 26.4.0；其他版本尚未建立相容性測試矩陣。
- 已登入 LINE 的主要手機；自己的帳號必須已加入來源與目的「一般群組」。
- 電腦保持連線、不休眠、不登出。只需要一台電腦，不操作滑鼠鍵盤。
- 沒有安裝精靈或 EXE。朋友各自下載程式、各自登入，不共用你的登入資料。

從 GitHub 的 Code → Download ZIP 下載並解壓縮，或使用 Git clone。開啟解壓縮後的專案資料夾，在檔案總管網址列輸入 `powershell` 並按 Enter。

```powershell
node --version
npm --version
cd yomi-probe
npm ci --ignore-scripts
npm test
```

預期測試全部通過。`npm test` 使用模擬服務，不讀取真實登入資料，也不向 LINE 發訊。不要執行 `npm audit fix --force`，以免換入未驗證版本。

如果 PowerShell 禁止執行 `npm.ps1`，改用 `npm.cmd ci --ignore-scripts` 與 `npm.cmd test`；不必永久修改電腦執行原則。

## 2. 登入並取得完整群名

回到專案根目錄，雙擊 `啟動一般群組驗證.cmd`，開啟 http://127.0.0.1:18765/ 。第一次輸入手機號碼，依頁面及手機提示完成授權；已有登入則按「使用本機已保存登入」。

按讀取群組列表，選擇來源群組，從完整群名欄位複製名稱（包含 emoji）。目的群組也用相同步驟複製。群組重名時請先調整名稱；程式不會任選一個。

手機介面可能隨 LINE 版本改變。沒有 PIN 輸入畫面時，參考 [疑難排解](TROUBLESHOOTING.md)，不要分享 PIN、登入檔或 E2EE 金鑰。

## 3. 啟動背景轉送

雙擊根目錄 `啟動自動轉送.cmd`。依序貼上來源完整名稱、目的完整名稱，每次按 Enter。提示文字為 SOURCE／DESTINATION，貼上的名稱可包含中文與 emoji，不必自行加引號。

前往 http://127.0.0.1:18766/status ，等 `phase` 為 `running`。首次建立歷史基準，不會轉送已有訊息；再於來源發一則新的測試文字，確認目的收到。

同時只支援一組來源／目的。詳細測試、停止、切換與更新方式見 [使用教學](USAGE.md)。

## 4. 分享給朋友

只分享 GitHub 網址或乾淨的原始碼 ZIP。不要分享 `%LOCALAPPDATA%\LineCallYomiProbe`、訊息匯出檔或自己的安裝工作目錄。朋友需自行執行上述安裝與登入步驟；不用購買 AI API。

登入資料採本機檔案儲存，啟動時限制為目前 Windows 使用者與 SYSTEM 可存取；**並非磁碟內容加密**。使用前請閱讀 [安全說明](../SECURITY.md) 與 README 的 LINE 帳號風險。
