import { spawn } from 'node:child_process';

let lastToastTime = 0;

// Fixed script: title and message only travel as environment values, never as command text.
// A native toast stays in the Action Center; when WinRT toasts are unavailable the balloon
// fallback keeps its process alive long enough for the tip to actually show.
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
export const NOTIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$title = [Security.SecurityElement]::Escape($env:LINEPORT_NOTIFY_TITLE)',
  '$body = [Security.SecurityElement]::Escape($env:LINEPORT_NOTIFY_MESSAGE)',
  'try {',
  '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '  $xml.LoadXml("<toast scenario=\'reminder\'><visual><binding template=\'ToastGeneric\'><text>$title</text><text>$body</text></binding></visual><actions><action content=\'OK\' arguments=\'dismiss\' activationType=\'system\'/></actions></toast>")',
  `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
  '} catch {',
  '  Add-Type -AssemblyName System.Windows.Forms',
  '  $notify = New-Object System.Windows.Forms.NotifyIcon',
  '  $notify.Icon = [System.Drawing.SystemIcons]::Warning',
  '  $notify.Visible = $true',
  '  $notify.ShowBalloonTip(10000, $env:LINEPORT_NOTIFY_TITLE, $env:LINEPORT_NOTIFY_MESSAGE, [System.Windows.Forms.ToolTipIcon]::$env:LINEPORT_NOTIFY_ICON)',
  '  Start-Sleep -Seconds 12',
  '  $notify.Dispose()',
  '}',
].join('\n');

export function notifyWindows(title, message, { throttleMs = 30000, icon = 'Warning', runner = spawn } = {}) {
  if (process.platform !== 'win32') return false;
  const now = Date.now();
  if (now - lastToastTime < throttleMs) return false;
  lastToastTime = now;
  try {
    const sanitize = str => String(str || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
    const tipIcon = ['Info', 'Warning', 'Error'].includes(icon) ? icon : 'Warning';
    const encoded = Buffer.from(NOTIFY_SCRIPT, 'utf16le').toString('base64');
    const child = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, LINEPORT_NOTIFY_TITLE: sanitize(title || 'LinePort'), LINEPORT_NOTIFY_MESSAGE: sanitize(message), LINEPORT_NOTIFY_ICON: tipIcon },
    });
    child?.on?.('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}
