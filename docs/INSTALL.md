# 安裝

> DESKTOPWIN 僅保留底層相容性、既有啟動器與獨立資料，未做真實登入或共存驗收；一般選單及切換 API 不開放此身分。它與 DESKTOPMAC 使用相同桌面授權流程，尚無已驗證的使用優勢，不作為官方 iPad 共存建議。

## 環境

Windows 11 x64。免安裝版內含執行環境；只有原始碼使用者才需要 Node.js 與 npm（已驗證 Node.js 26.4.0）。一台持續連網、不休眠的電腦。使用 LINE 時需主要裝置授權；只用 Telegram 時不需要 LINE 登入。主要裝置不限定 iPhone；主機與 LINE 登入身分的差別見[相容性矩陣](COMPATIBILITY.md)。macOS／Linux 主機尚未支援。

一般使用者請下載 [v1.0.0-rc.1 Windows 免安裝候選版](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.1/LinePort-v1.0.0-rc.1-Windows-x64.zip)，全部解壓後雙擊 LinePort.exe。候選版待實機驗收，詳見[使用與更新說明](PORTABLE.md)。不需要另外安裝 .NET 或 AI API。

## 安裝與啟動

原始碼使用者可下載 [候選版原始碼](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.1/LinePort-v1.0.0-rc.1.zip)，依[版本說明](RELEASE-1.0.0-rc.1.md)核對 SHA-256。在專案資料夾的檔案總管網址列輸入 `powershell`：

```powershell
cd yomi-probe
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd start
```

`npm.cmd` 可避免 PowerShell 的 npm.ps1 執行原則限制。測試全用模擬服務，不對真實平台發訊。

## 連結與設定

一般帳號連結頁只提供 **原有桌面授權（DESKTOPMAC）** 與 **iPad QR 登入（IOSIPAD，實驗）**。要保留官方電腦版時先選本次實測的 iPad QR；沿用既有登入與設定則選原有桌面授權，後者可能使官方電腦版登出。需要保留官方 iPad LINE 時，目前沒有已驗證方案，可另行驗收原有桌面授權。選擇不依主機或手機品牌決定，無需實體 iPad／Mac。

開啟 http://127.0.0.1:18765/：

1. 使用 LINE：在「帳號連結」選身分，先保存編輯及停止轉送，再按「切換身分並重啟服務」。各身分的登入、平台連結、規則與紀錄分開保存，切換後不會自動登入／啟動轉送。桌面身分輸入手機號碼申請主要裝置授權；iPad 身分按 QR 登入並以主要裝置掃碼、完成 PIN／授權。已有同身分登入會自動恢復；失敗時依頁面提示重試。
2. 登入後自動載入 LINE 群組與好友；只有已加入群組及好友會出現。
3. 使用 Telegram：連結自己的 Bot Token，依 [Telegram 設定](USAGE.md#telegram) 授予聊天室權限。
4. 在「轉送規則」新增規則，依序選來源與發訊者、目的與訊息條件，確認預覽後保存。
5. 開始轉送，基準完成後發新文字，確認各目的收到。

也可雙擊專案根目錄 `啟動一般群組驗證.cmd` 啟動；舊檔名保留相容性。手機沒有授權提示時見 [疑難排解](TROUBLESHOOTING.md)。

一般啟動器會開啟目前執行中的模式。v1.0.0-rc.1 起完整停止後會記住最後成功啟動的身分；首次使用才預設為原有桌面身分。要指定重開實驗模式，可使用 `啟動iPad實驗模式.cmd`。其他模式仍在執行時，指定模式啟動器會拒絕重用，請回帳號頁切換。

## 分享

分享 GitHub 網址或原始碼 ZIP。朋友自行安裝，使用自己的 LINE 帳號或 Telegram Bot。不要附上 `%LOCALAPPDATA%\LineCallYomiProbe`、Bot Token 或訊息匯出檔。

[使用與更新](USAGE.md) · [安全說明](../SECURITY.md)
