# 安裝

## 環境

- Windows 11、Node.js 與 npm。已驗證 Node.js 26.4.0，其他版本尚未建立相容性矩陣。
- 已登入 LINE 的主要手機；帳號已加入來源與目的的一般群組。
- 一台可持續連網、不休眠的電腦。

目前提供原始碼，沒有 EXE 安裝檔。不需要 .NET 或 AI API。

## 安裝依賴

從 [GitHub](https://github.com/b40609/line-relay-bridge) 選擇 **Code → Download ZIP**，解壓縮。於專案資料夾的檔案總管網址列輸入 `powershell`，執行：

```powershell
cd yomi-probe
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd start
```

`npm.cmd` 可避免 PowerShell 的 `npm.ps1` 執行原則限制。測試全部採模擬服務，不會對 LINE 發訊。

## 登入與轉送

開啟 http://127.0.0.1:18765/：

1. 輸入 LINE 手機號碼，按「手機授權登入」。
2. 手機 LINE → 設定 → 我的帳號，確認「允許自其他裝置登入」已開啟。依「連動其他裝置」提示輸入頁面 PIN，完成 Face ID／Touch ID 授權。
3. 按「載入群組列表」，選擇不同的來源與目的群組。
4. 按「開始轉送」，等「轉送中」再發新文字測試。

下次使用可按「使用已保存的登入」。若手機沒有授權畫面，查看 [疑難排解](TROUBLESHOOTING.md)。

也可從專案根目錄雙擊 `啟動一般群組驗證.cmd` 啟動本機網頁；舊版檔名仍保留相容性。

## 分享

分享 GitHub 網址或原始碼 ZIP；朋友自行安裝並授權自己的 LINE 帳號。不要附上 `%LOCALAPPDATA%\LineCallYomiProbe` 或訊息匯出檔。

停止、切換與更新方式見 [使用教學](USAGE.md)；帳號與本機資料限制見 [安全說明](../SECURITY.md)。
