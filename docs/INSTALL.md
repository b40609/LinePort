# 安裝

## 環境

Windows 11、Node.js 與 npm；已驗證 Node.js 26.4.0。一台持續連網、不休眠的電腦。使用 LINE 時需主要裝置授權；只用 Telegram 時不需要 LINE 登入。主要裝置不限定 iPhone；主機與 LINE 登入身分的差別見[相容性矩陣](COMPATIBILITY.md)。macOS／Linux 主機尚未支援。

目前提供原始碼，沒有 EXE 安裝檔，不需要 .NET 或 AI API。

## 安裝與啟動

下載 [v0.8.3 ZIP](https://github.com/b40609/LinePort/releases/download/v0.8.3/LinePort-v0.8.3.zip)（先依 [更新說明](RELEASE-0.8.3.md) 核對 SHA-256）並解壓縮。需要登入身分選單及實驗模式，請改用 [master 原始碼 ZIP](https://github.com/b40609/LinePort/archive/refs/heads/master.zip)，既有發布 ZIP 尚未包含。在專案資料夾的檔案總管網址列輸入 `powershell`：

```powershell
cd yomi-probe
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd start
```

`npm.cmd` 可避免 PowerShell 的 npm.ps1 執行原則限制。測試全用模擬服務，不對真實平台發訊。

## 連結與設定

master 原始碼的「帳號連結」提供 Mac 桌面、Windows 桌面實驗及 iPad QR 實驗三種身分。需要保留官方電腦版時可選 [iPad 身分](IPAD-EXPERIMENT.md)；需要保留官方 iPad 時可測試 Windows 桌面身分，後者真實登入及共存尚待驗收。選擇依工作需求，不以 LinePort 主機或手機品牌決定；無需為選取身分購買對應裝置。

開啟 http://127.0.0.1:18765/：

1. 使用 LINE：在「帳號連結」選身分，先保存編輯及停止轉送，再按「切換身分並重啟服務」。各身分的登入、平台連結、規則與紀錄分開保存，切換後不會自動登入／啟動轉送。桌面身分輸入手機號碼申請主要裝置授權；iPad 身分按 QR 登入並以主要裝置掃碼、完成 PIN／授權。已有同身分登入則按「使用已保存的登入」。
2. 按「載入 LINE 群組與好友」。只有已加入群組及好友會出現。
3. 使用 Telegram：連結自己的 Bot Token，依 [Telegram 設定](USAGE.md#telegram) 授予聊天室權限。
4. 在「轉送規則」新增規則，依序選來源與發訊者、目的與訊息條件，確認預覽後保存。
5. 開始轉送，基準完成後發新文字，確認各目的收到。

也可雙擊專案根目錄 `啟動一般群組驗證.cmd` 啟動；舊檔名保留相容性。手機沒有授權提示時見 [疑難排解](TROUBLESHOOTING.md)。

一般啟動器會開啟目前執行中的模式。完全停止後預設為原 Mac 桌面身分；要直接重開實驗模式，請使用 `啟動Windows實驗模式.cmd` 或 `啟動iPad實驗模式.cmd`。其他模式仍在執行時，指定模式啟動器會拒絕重用，請回帳號頁切換。

## 分享

分享 GitHub 網址或原始碼 ZIP。朋友自行安裝，使用自己的 LINE 帳號或 Telegram Bot。不要附上 `%LOCALAPPDATA%\LineCallYomiProbe`、Bot Token 或訊息匯出檔。

[使用與更新](USAGE.md) · [安全說明](../SECURITY.md)
