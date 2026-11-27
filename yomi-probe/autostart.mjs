import path from 'node:path';
import { access, mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from './local-http.mjs';

// Autostart preference contains only on/off switches; no credentials are stored here.
const filename = 'autostart.json';
const shortcutBase = 'LinePort 自動啟動';
const serviceScript = 'autostart-service.ps1';
const relayScript = 'autostart-relay.ps1';
const intentFile = 'relay-intent.json';
export const AUTOSTART_SCHEMA_VERSION = 2;
export const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// Same ordering as Compare-LinePortVersion in upgrade-service.ps1: x.y.z, and -rc.N below the final release.
function parseVersion(value) {
  const match = typeof value === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : 0, Number(match[4] || 0)] : null;
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error('Unrecognized LinePort version');
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}
async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
// Newest LinePort version that wrote the preference or either entrypoint script; '' when none is recorded.
export async function writtenByVersion(localAppData) {
  const directory = scriptDirectory(localAppData);
  const found = [];
  try { found.push(JSON.parse(await readText(path.join(directory, filename)) || '{}').writtenByVersion); } catch {}
  for (const name of [serviceScript, relayScript]) found.push(/^# writtenByVersion: (\S+)\r?$/m.exec(await readText(path.join(directory, name)))?.[1]);
  return found.filter(parseVersion).sort(compareVersions).at(-1) || '';
}
// Blocks an older release from overwriting entrypoints a newer release wrote (the 11/14 incident).
export async function assertNotDowngrade(localAppData, version = APP_VERSION) {
  const existing = await writtenByVersion(localAppData);
  if (existing && compareVersions(version, existing) < 0) {
    throw new HttpError(409, `自動啟動設定由較新的 LinePort v${existing} 寫入；目前版本 v${version} 不會覆寫，避免開機啟動錯誤版本。請改用 v${existing} 或更新版調整。`);
  }
}

export function normalizeAutostart(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '自動啟動設定格式不正確');
  const service = input.service;
  const relay = input.relay;
  if (typeof service !== 'boolean' || typeof relay !== 'boolean') throw new HttpError(400, '自動啟動設定格式不正確');
  return { service, relay };
}

function scriptDirectory(localAppData) {
  return path.join(localAppData, 'LinePort');
}

function startupDirectory() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

// Reads the installer task choice (HKCU\Software\LinePort\AutostartTask). When the user
// ticked "autostart" during setup and no preference exists yet, seed service+relay on
// and install the Startup shortcuts once. Returns true when it seeded.
export async function seedFromInstallerTask(localAppData = process.env.LOCALAPPDATA, options = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const shell = options.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = promisify(execFile);
  let choice = '';
  try {
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\LinePort' -Name AutostartTask -ErrorAction SilentlyContinue).AutostartTask"], { windowsHide: true, timeout: 15000 });
    choice = String(stdout || '').trim();
  } catch { return false; }
  if (choice !== 'enabled') return false;
  const store = createAutostartStore(localAppData, options);
  // Only the very first run seeds: an existing preference (even both switches off) wins,
  // so upgrading can never turn autostart back on behind the user's back.
  try { await access(path.join(scriptDirectory(localAppData), filename)); return false; }
  catch (error) { if (error.code !== 'ENOENT') return false; }
  await store.save({ service: true, relay: true });
  return true;
}

export function createAutostartStore(localAppData = process.env.LOCALAPPDATA, options = {}) {
  if (!localAppData) throw new Error('LOCALAPPDATA is required');
  const directory = scriptDirectory(localAppData);
  const file = path.join(directory, filename);
  const apply = options.apply || (async () => {});
  let lastShortcuts;
  return {
    async load() {
      try { return normalizeAutostart(JSON.parse(await readFile(file, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return { service: false, relay: false }; throw error; }
    },
    async save(value) {
      const normalized = normalizeAutostart(value);
      await mkdir(directory, { recursive: true });
      await assertNotDowngrade(localAppData, options.version);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...normalized, schemaVersion: AUTOSTART_SCHEMA_VERSION, writtenByVersion: options.version || APP_VERSION }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      try { lastShortcuts = await apply(normalized, localAppData); }
      catch { throw new HttpError(503, '自動啟動捷徑更新失敗；設定已保存，請檢查啟動資料夾權限後重試'); }
      return normalized;
    },
    lastShortcuts: () => lastShortcuts,
    // Records whether the user last started or stopped the relay, so the watchdog never undoes a manual stop.
    async saveRelayIntent(desired) {
      if (!['running', 'stopped'].includes(desired)) throw new Error('Invalid relay intent');
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, intentFile), temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ desired, at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    },
    async loadRelayIntent() {
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, intentFile), 'utf8'));
        return parsed && ['running', 'stopped'].includes(parsed.desired) ? { desired: parsed.desired, at: typeof parsed.at === 'string' ? parsed.at : '' } : null;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
  };
}

// At startup, rewrite enabled entrypoints that an older release left behind (never a newer one's).
export async function refreshAutostartScripts(localAppData = process.env.LOCALAPPDATA, options = {}) {
  const enabled = await createAutostartStore(localAppData).load();
  if (!enabled.service && !enabled.relay) return false;
  const directory = scriptDirectory(localAppData), version = options.version || APP_VERSION;
  const versions = await Promise.all([serviceScript, relayScript].map(async name => /^# writtenByVersion: (\S+)\r?$/m.exec(await readText(path.join(directory, name)))?.[1]));
  if (versions.every(value => parseVersion(value) && compareVersions(version, value) === 0)) return false;
  // A newer writer makes this throw instead of downgrading the scripts.
  await writeAutostartScripts(localAppData, options);
  return true;
}

// Writes the two hidden PowerShell entrypoints that Startup shortcuts invoke.
// The relay script polls the local UI, reads its one-time token, and starts the relay
// with the saved rules through the same API the page uses.
export async function writeAutostartScripts(localAppData, options = {}) {
  if (!localAppData) throw new Error('LOCALAPPDATA is required');
  const directory = scriptDirectory(localAppData);
  await mkdir(directory, { recursive: true });
  const version = options.version || APP_VERSION;
  await assertNotDowngrade(localAppData, version);
  // Hidden windows swallow errors, so every outcome goes to a rotating log beside the script.
  const header = source => `# LinePort autostart entrypoint (generated; do not edit)
# schemaVersion: ${AUTOSTART_SCHEMA_VERSION}
# writtenByVersion: ${version}
$ErrorActionPreference = 'Stop'
$lineportLog = Join-Path $PSScriptRoot 'autostart.log'
function Write-LinePortLog([string]$Message) {
    try {
        $entry = '{0} [${source} v${version}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), ($Message -replace '[\\r\\n]+', ' ')
        $kept = @()
        if (Test-Path -LiteralPath $lineportLog) { $kept = @(Get-Content -LiteralPath $lineportLog -Tail 199 -Encoding UTF8) }
        # Retry briefly: antivirus scans can hold the log file for a moment.
        for ($try = 0; $try -lt 5; $try++) { try { Set-Content -LiteralPath $lineportLog -Value (@($kept) + $entry) -Encoding UTF8; break } catch { Start-Sleep -Milliseconds 200 } }
    } catch { }
}
trap {
    $text = [string]$_.Exception.Message
    Write-LinePortLog ('failed: ' + $_.Exception.GetType().Name + ': ' + $text.Substring(0, [Math]::Min(300, $text.Length)))
    exit 1
}
`;
  const appRoot = options.appRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const installedRoot = path.join(localAppData, 'Programs', 'LinePort', 'versions');
  const relative = path.relative(installedRoot, appRoot);
  const installed = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  const portableLauncher = path.join(appRoot, 'LinePort.exe').replaceAll("'", "''");
  const selectLauncher = installed
    // Installer folders are "<version>-<yyyymmddhhmmss>": pick the highest version, not the latest touched folder.
    ? `$root = Join-Path $env:LOCALAPPDATA 'Programs\\LinePort\\versions'
$launcher = Get-ChildItem -LiteralPath $root -Directory -ErrorAction Stop | ForEach-Object {
    if ($_.Name -match '^(\\d+)\\.(\\d+)\\.(\\d+)(?:-rc\\.(\\d+))?-(\\d{14})$') {
        $rank = '{0:D9}{1:D9}{2:D9}{3}{4:D9}{5}' -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $(if ($Matches[4]) { '0' } else { '1' }), [int]$(if ($Matches[4]) { $Matches[4] } else { 0 }), $Matches[5]
        [pscustomobject]@{ Rank = $rank; Path = (Join-Path $_.FullName 'LinePort.exe') }
    }
} | Where-Object { Test-Path -LiteralPath $_.Path } | Sort-Object Rank -Descending | Select-Object -First 1 -ExpandProperty Path
`
    : `$launcher = '${portableLauncher}'\n`;
  const service = `${header('service')}${selectLauncher}if (!$launcher -or !(Test-Path -LiteralPath $launcher)) { throw 'LinePort.exe not found.' }
Start-Process -FilePath $launcher -WorkingDirectory (Split-Path -Parent $launcher) -WindowStyle Hidden
Write-LinePortLog ('started service launcher: ' + $launcher)
`;
  const relay = `${header('relay')}
$base = 'http://127.0.0.1:18765'
$token = ''
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
        $html = (Invoke-WebRequest -Uri ($base + '/') -UseBasicParsing -TimeoutSec 2).Content
        if ($html -match "const token='([a-f0-9]{64})'") { $token = $Matches[1]; break }
    } catch { }
    Start-Sleep -Milliseconds 1000
}
if (!$token) { Write-LinePortLog 'local UI did not answer within 120 seconds; relay not started'; exit 1 }
$headers = @{ 'X-Probe-Token' = $token }
try {
    $state = Invoke-RestMethod -Uri ($base + '/api/relay/status') -Headers $headers -TimeoutSec 5
    if ($state.phase -in @('running', 'degraded', 'starting')) { Write-LinePortLog ('relay already ' + $state.phase); exit 0 }
    $account = Invoke-RestMethod -Uri ($base + '/api/status') -Headers $headers -TimeoutSec 5
    if (!$account.connected -and !$account.busy -and $account.phase -eq 'idle') {
        # A new UI process does not resume the saved LINE session on its own.
        # Non-LINE rules must still be allowed to start if there is no LINE session.
        try { Invoke-RestMethod -Uri ($base + '/api/resume') -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 45 | Out-Null } catch { }
    }
    Invoke-RestMethod -Uri ($base + '/api/relay/start') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"useRules":true}' -TimeoutSec 15 | Out-Null
    Write-LinePortLog 'relay start requested with saved rules'
} catch {
    $text = [string]$_.Exception.Message
    Write-LinePortLog ('relay start failed: ' + $text.Substring(0, [Math]::Min(300, $text.Length)))
    exit 1
}
`;
  const write = async (name, content) => {
    const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
    // Windows PowerShell 5.1 reads BOM-less scripts as ANSI; the BOM keeps non-ASCII install paths intact.
    await writeFile(temporary, '﻿' + content, 'utf8');
    await rename(temporary, path.join(directory, name));
  };
  await write(serviceScript, service);
  await write(relayScript, relay);
  return { directory, serviceScript: path.join(directory, serviceScript), relayScript: path.join(directory, relayScript) };
}

// Installs or removes both Startup shortcuts according to the enabled switches.
// Shortcuts always point at the scripts, so upgrading the version directory needs no rewrite.
export async function applyAutostartShortcuts(enabled, localAppData = process.env.LOCALAPPDATA, options = {}) {
  const shell = options.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const psQuote = value => `'` + String(value).replaceAll(`'`, `''`) + `'`;
  const startup = startupDirectory();
  await mkdir(startup, { recursive: true });
  const scripts = await writeAutostartScripts(localAppData, options);
  const targets = [
    { kind: 'service', lnk: path.join(startup, `${shortcutBase}.lnk`), script: scripts.serviceScript, description: 'LinePort 登入自動啟動本機服務' },
    { kind: 'relay', lnk: path.join(startup, `${shortcutBase} 轉送.lnk`), script: scripts.relayScript, description: 'LinePort 登入自動啟動轉送（沿用已保存規則）' },
  ];
  const results = [];
  for (const entry of targets) {
    const wanted = (entry.kind === 'service' && enabled.service) || (entry.kind === 'relay' && enabled.relay);
    if (!wanted) { await unlink(entry.lnk).catch(error => { if (error.code !== 'ENOENT') throw error; }); results.push({ kind: entry.kind, enabled: false }); continue; }
    // WScript.Shell.CreateShortcut uses the system ANSI code page and fails on non-CJK Windows when the .lnk
    // filename contains Chinese characters; save to an ASCII path first, then rename via Unicode Move-Item.
    const tempLnk = path.join(startup, `lineport-${entry.kind}-${randomUUID()}.lnk`);
    const command = [
      `$ws = New-Object -ComObject WScript.Shell`,
      `$s = $ws.CreateShortcut(${psQuote(tempLnk)})`,
      `$s.TargetPath = ${psQuote(shell)}`,
      `$s.Arguments = ${psQuote('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + entry.script + '"')}`,
      `$s.WorkingDirectory = ${psQuote(scriptDirectory(localAppData))}`,
      `$s.Description = ${psQuote(entry.description)}`,
      `$s.Save()`,
      `Move-Item -LiteralPath ${psQuote(tempLnk)} -Destination ${psQuote(entry.lnk)} -Force`,
    ].join('\n');
    await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
    results.push({ kind: entry.kind, enabled: true });
  }
  return results;
}
