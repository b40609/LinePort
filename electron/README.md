# LinePort Electron 桌面應用程式 (OmniRoute 架構)

此模組提供與 OmniRoute 同款的獨立 Electron 桌面應用程式包裝。

## 特色
1. **獨立原生視窗**：純淨 App 視窗，無瀏覽器網址列、書籤與分頁干擾。
2. **常駐系統匣（Close-to-Tray）**：點擊視窗右上角 `X` 自動隱藏至右下角系統匣，訊息轉送持續進行不中斷。
3. **托盤快捷選單**：支援點擊切換視窗顯示/隱藏、右鍵重新載入或結束程式。
4. **自動服務接管**：啟動時自動探測本機 18765 轉送服務；若未啟動則自動於背景帶起，程式退出時妥善清理。
5. **單一實例防重複**：防止重複雙擊開啟多重視窗，重複啟動自動喚醒聚焦既有視窗。

## 開發與執行
```powershell
cd electron
npm install
npm start
```

## 打包成 .exe (NSIS 安裝檔與 Portable 免安裝版)
```powershell
npm run build
```
產出的 `.exe` 將輸出至 `dist/electron-release/` 目錄。
