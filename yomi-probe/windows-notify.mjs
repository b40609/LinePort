import { spawn } from 'node:child_process';

let lastToastTime = 0;

export function notifyWindows(title, message, { throttleMs = 30000, icon = 'Warning', runner = spawn } = {}) {
  if (process.platform !== 'win32') return false;
  const now = Date.now();
  if (now - lastToastTime < throttleMs) return false;
  lastToastTime = now;
  try {
    const sanitize = str => String(str || '').replace(/[\r\n\x00-\x1f"`$;|&]/g, ' ').slice(0, 200);
    const safeTitle = sanitize(title || 'LinePort');
    const safeMessage = sanitize(message || '');
    const tipIcon = ['Info', 'Warning', 'Error'].includes(icon) ? icon : 'Warning';
    const script = `Add-Type -AssemblyName System.Windows.Forms; $notify = New-Object System.Windows.Forms.NotifyIcon; $notify.Icon = [System.Drawing.SystemIcons]::Information; $notify.Visible = $true; $notify.ShowBalloonTip(5000, "${safeTitle}", "${safeMessage}", [System.Windows.Forms.ToolTipIcon]::${tipIcon}); Start-Sleep -Milliseconds 200; $notify.Dispose()`;
    const child = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}
