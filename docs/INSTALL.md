# 安裝

## 環境

Windows 11、Node.js 與 npm；已驗證 Node.js 26.4.0。一台持續連網、不休眠的電腦。使用 LINE 時需主要手機授權；只用 Telegram 時不需要 LINE 登入。

目前提供原始碼，沒有 EXE 安裝檔，不需要 .NET 或 AI API。

## 安裝與啟動

下載 [最新版 ZIP](https://github.com/b40609/LinePort/archive/refs/heads/master.zip) 並解壓縮。在專案資料夾的檔案總管網址列輸入 `powershell`：

```powershell
cd yomi-probe
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd start
```

`npm.cmd` 可避免 PowerShell 的 npm.ps1 執行原則限制。測試全用模擬服務，不對真實平台發訊。

## 連結與設定

開啟 http://127.0.0.1:18765/：

1. 使用 LINE：輸入手機號碼申請授權；手機設定確認允許其他裝置登入，依提示完成 PIN 與手機授權。已有登入則按「使用已保存的登入」。
2. 按「載入 LINE 群組與好友」。只有已加入群組及好友會出現。
3. 使用 Telegram：連結自己的 Bot Token，依 [Telegram 設定](USAGE.md#telegram) 授予聊天室權限。
4. 選取來源、目的，多選按住 Ctrl；新增並保存規則。
5. 開始轉送，基準完成後發新文字，確認各目的收到。

也可雙擊專案根目錄 `啟動一般群組驗證.cmd` 啟動；舊檔名保留相容性。手機沒有授權提示時見 [疑難排解](TROUBLESHOOTING.md)。

## 分享

分享 GitHub 網址或原始碼 ZIP。朋友自行安裝，使用自己的 LINE 帳號或 Telegram Bot。不要附上 `%LOCALAPPDATA%\LineCallYomiProbe`、Bot Token 或訊息匯出檔。

[使用與更新](USAGE.md) · [安全說明](../SECURITY.md)
