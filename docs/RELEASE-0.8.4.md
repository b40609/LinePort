# v0.8.4：可選 iPad QR 登入與聊天室頭像

原有桌面授權使用 DESKTOPMAC 身分，即使 LinePort 在 Windows 執行，也可能使官方電腦版 LINE 登出。本版增加 iPad QR 實驗模式，讓需要同時使用官方電腦版的使用者有另一個登入選擇，不需要實體 iPad，也不限定手機系統。單一帳號已完成 QR 登入、重啟恢復及官方電腦版共存確認；不保證其他帳號、裝置組合或長期共存。iPad 模式的訊息解密與轉送仍待實機驗收。

介面保留兩個入口：原有桌面授權與 iPad QR；未驗收的 Windows 身分不列入公開選單。不同身分的登入與規則分開保存，不會自動搬移。

修正來源清單單選鈕寬度造成的名稱空白；群組與好友頭像放在名稱左側，缺圖時顯示預設圖示。真實帳號已載入 46 個群組及 356 位好友，抽查可見群組／好友頭像成功顯示。另包含 QR 取消與登入診斷改善。

## 下載與啟動

[下載 ZIP](https://github.com/b40609/LinePort/releases/download/v0.8.4/LinePort-v0.8.4.zip) · [SHA-256](https://github.com/b40609/LinePort/releases/download/v0.8.4/SHA256SUMS.txt)

1. 安裝 Node.js，將 ZIP 解壓至新目錄。此套件包含程式原始碼與啟動器，不含 Node.js 或 node_modules。
2. 在解壓目錄開啟 PowerShell，執行 `cd yomi-probe`、`npm.cmd ci --ignore-scripts`。
3. 雙擊根目錄的「啟動一般群組驗證.cmd」，或執行 `npm.cmd start`。
4. 開啟本機頁面，在「帳號連結」依需要選擇登入方式；要保留官方電腦版時先選 iPad QR，再以主要裝置 LINE 掃碼授權。

舊版更新前先停止轉送與服務，私下備份完整資料目錄；新版解壓至另一目錄，重新整理頁面並載入群組與好友。不要覆蓋私人登入資料，不要將新版待送資料交給舊版。

## 驗證範圍

214 項自動化測試通過。真實登入與頭像驗證沒有啟動轉送或發送訊息；可見頭像採延遲載入，不代表已逐一驗收所有圖片。[完整驗收紀錄](ACCEPTANCE-2026-10-21.md) · [iPad 實驗限制](IPAD-EXPERIMENT.md)
