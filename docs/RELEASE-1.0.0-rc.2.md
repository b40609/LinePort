# v1.0.0-rc.2：Bot 目的群組文字相容修補與 Windows 安裝版

2026-10-22。此版包含本次已通過 LINE 雙目的文字收件驗收的修補，仍以候選版發布；完整 Windows 重啟、長時間運作及其他帳號／裝置組合尚未驗證。

## 下載與更新

- [Windows 安裝版 EXE](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.2/LinePort-v1.0.0-rc.2-Windows-x64-Setup.exe)：執行安裝程式，再由桌面 LinePort 捷徑啟動。內含 Node.js、.NET 與依賴套件，不需另外安裝執行環境。
- [Windows 免安裝 ZIP](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.2/LinePort-v1.0.0-rc.2-Windows-x64.zip)：全部解壓至新資料夾，雙擊 LinePort.exe；不能只搬走 EXE。
- [原始碼 ZIP](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.2/LinePort-v1.0.0-rc.2.zip) 與 [SHA-256 校驗檔](https://github.com/b40609/LinePort/releases/download/v1.0.0-rc.2/SHA256SUMS.txt)。

支援 Windows 11 x64，EXE 尚未簽署數位憑證。安裝不要求管理員權限，每次使用新版本目錄；阻擋可辨識的降版，保留既有版本。新版啟動器會安全切換可辨識的舊服務，保留原登入身分、規則與轉送紀錄；更新後請確認規則並按「開始轉送」。若正在手機授權，完成後再更新。

建議維持預設安裝路徑；過長的自訂路徑可能超過 Windows 路徑限制而使安裝回復。免安裝 ZIP 也請解壓至較短路徑。

## 修正內容

- 修正部分目的含 Bot／官方帳號、無可用群組金鑰時，整條目的路線停在加密準備的問題。先嘗試端對端加密；只有明確缺少群組金鑰、仍為群組成員，且確認官方帳號明確不支援 E2EE，才自動使用文字相容模式。
- 相容文字仍有 LINE 連線傳輸加密，但無 Letter Sealing 端對端加密，LINE 伺服器可處理內容；各目的狀態明確標示。其他目的維持原加密方式。
- 偵測限 50 名成員、4 個並行查詢與 5 秒；資料不足、逾時、其他金鑰或網路錯誤不觸發切換。發送失敗後不切換模式重送，避免重複發訊。
- 相容模式僅支援文字；啟用媒體的規則在目的初始化即阻擋，請另建純文字規則。這是目的群的發送相容處理，不會把目的 Bot 的訊息加入來源。
- 修正非空但不完整的自身金鑰快取恢復：合併保存的多代 bootstrap 金鑰、不覆蓋較新金鑰；目的失敗原因改以固定白名單呈現。

## 驗證範圍

本次修補的完整測試 275 項通過、0 失敗／跳過。實機使用 IOSIPAD 身分、原登入與原規則；使用者確認一則全新來源文字到一般目的與 Bot 目的各一次，後台各接受 1 則、錯誤／待送／不明均 0，來源解密失敗 0。平台接受訊息不等於收件保證，本次另有使用者實際收件確認。

打包與隔離驗證紀錄見 [VERIFICATION.md](../yomi-probe/VERIFICATION.md)。未把此次文字驗收擴大為媒體、跨平台、完整 Windows 重啟或長時間穩定性通過。

## 重新建置

開發環境需 Node.js／npm、.NET 10 SDK 與 Inno Setup 6.7.3；Inno 編譯器的 Languages 目錄需備有上游 ChineseTraditional.isl。先執行 `scripts/Build-Portable.ps1 -OutputDirectory <全新目錄>`，再執行 `scripts/Build-Installer.ps1 -PortableDirectory <免安裝目錄> -OutputDirectory <另一全新目錄> -IsccPath <ISCC.exe 路徑>`。兩個腳本都拒絕覆寫既有輸出目錄。
