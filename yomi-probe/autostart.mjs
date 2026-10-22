import path from 'node:path';
import { access, mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HttpError } from './local-http.mjs';

// Autostart preference contains only on/off switches; no credentials are stored here.
const filename = 'autostart.json';
const shortcutBase = 'LinePort 自動啟動';
const serviceScript = 'autostart-service.ps1';
const relayScript = 'autostart-relay.ps1';

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
  return {
    async load() {
      try { return normalizeAutostart(JSON.parse(await readFile(file, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return { service: false, relay: false }; throw error; }
    },
    async save(value) {
      const normalized = normalizeAutostart(value);
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(normalized), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      await apply(normalized);
      return normalized;
    },
  };
}

// Writes the two hidden PowerShell entrypoints that Startup shortcuts invoke.
// The relay script polls the local UI, reads its one-time token, and starts the relay
// with the saved rules through the same API the page uses.
export async function writeAutostartScripts(localAppData, options = {}) {
  if (!localAppData) throw new Error('LOCALAPPDATA is required');
  const directory = scriptDirectory(localAppData);
  await mkdir(directory, { recursive: true });
  const header = `$ErrorActionPreference = 'Stop'\n$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'LinePort.exe'\nif (!(Test-Path -LiteralPath $launcher)) { throw 'LinePort.exe not found; run the installer or portable launcher once first.' }\n`;
  const service = `${header}Start-Process -FilePath $launcher -WorkingDirectory (Split-Path -Parent $launcher) -WindowStyle Hidden\n`;
  const relay = `${header}
$base = 'http://127.0.0.1:18765'
$token = ''
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
        $html = (Invoke-WebRequest -Uri ($base + '/') -UseBasicParsing -TimeoutSec 2).Content
        if ($html -match "const token='([a-f0-9]{64})'") { $token = $Matches[1]; break }
    } catch { }
    Start-Sleep -Milliseconds 1000
}
if (!$token) { exit 1 }
$headers = @{ 'X-Probe-Token' = $token }
try {
    $state = Invoke-RestMethod -Uri ($base + '/api/relay/status') -Headers $headers -TimeoutSec 5
    if ($state.phase -in @('running', 'degraded', 'starting')) { exit 0 }
    Invoke-RestMethod -Uri ($base + '/api/relay/start') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"useRules":true}' -TimeoutSec 15 | Out-Null
} catch { exit 1 }
`;
  const write = async (name, content) => {
    const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, content, 'utf8');
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
    const command = [
      `$ws = New-Object -ComObject WScript.Shell`,
      `$s = $ws.CreateShortcut(${psQuote(entry.lnk)})`,
      `$s.TargetPath = ${psQuote(shell)}`,
      `$s.Arguments = ${psQuote('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + entry.script + '"')}`,
      `$s.WorkingDirectory = ${psQuote(scriptDirectory(localAppData))}`,
      `$s.Description = ${psQuote(entry.description)}`,
      `$s.Save()`,
    ].join('\n');
    await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 30000 });
    results.push({ kind: entry.kind, enabled: true });
  }
  return results;
}
