const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const logFile = path.join(__dirname, 'electron.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
}
log('Starting LinePort Electron...');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;

const PROBE_URL = 'http://127.0.0.1:18765/';
const APP_TITLE = 'LinePort';

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
log(`gotTheLock: ${gotTheLock}`);
if (!gotTheLock) {
  log('Could not get single instance lock, quitting.');
  app.quit();
} else {
  log('Lock acquired, waiting for app ready...');
  app.on('second-instance', () => {
    log('second-instance triggered');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log('app is ready, ensuring server...');
    await ensureServerRunning();
    log('server ensured, creating window...');
    createWindow();
    log('window created, creating tray...');
    createTray();
    log('tray created successfully.');
  }).catch(err => {
    log(`app ready error: ${err.stack || err}`);
  });
}

function probeServerReady() {
  return new Promise((resolve) => {
    const req = http.get(PROBE_URL, { timeout: 1000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureServerRunning() {
  const ready = await probeServerReady();
  if (ready) return;

  const yomiProbeDir = path.join(__dirname, '..', 'yomi-probe');
  const serverScript = path.join(yomiProbeDir, 'server.mjs');

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LINEPORT_LINE_DEVICE: process.env.LINEPORT_LINE_DEVICE || 'IOSIPAD',
    UV_THREADPOOL_SIZE: '16',
  };

  serverProcess = spawn(process.execPath || 'node', [serverScript], {
    cwd: yomiProbeDir,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });

  // Wait for the local server to start up
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await probeServerReady()) return;
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'package', 'Assets', 'Logo.png');
  const icon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 460,
    minHeight: 600,
    title: APP_TITLE,
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(PROBE_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle external links safely in OS browser (scheme allowlist: http / https only)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin === 'http://127.0.0.1:18765') return { action: 'allow' };
      if (['http:', 'https:'].includes(parsed.protocol)) {
        shell.openExternal(url);
      }
    } catch {
      // Ignore invalid or malformed URIs
    }
    return { action: 'deny' };
  });

  // Guard against arbitrary in-window navigation
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsed = new URL(navigationUrl);
      if (parsed.origin !== 'http://127.0.0.1:18765') {
        event.preventDefault();
        if (['http:', 'https:'].includes(parsed.protocol)) {
          shell.openExternal(navigationUrl);
        }
      }
    } catch {
      event.preventDefault();
    }
  });

  // Close to Tray behavior
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'package', 'Assets', 'SmallLogo.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(path.join(__dirname, '..', 'package', 'Assets', 'Logo.png'));
  }

  tray = new Tray(icon);
  tray.setToolTip(APP_TITLE);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '顯示 LinePort',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '重新載入介面',
      click: () => {
        if (mainWindow) mainWindow.reload();
      },
    },
    { type: 'separator' },
    {
      label: '結束 LinePort',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Left click toggles window
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {}
    serverProcess = null;
  }
});

app.on('window-all-closed', () => {
  // Keep alive in tray on Windows unless explicitly quitting
  if (isQuitting) {
    app.quit();
  }
});
