import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, copyFile, unlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeAutostart, createAutostartStore, writeAutostartScripts, applyAutostartShortcuts, refreshAutostartScripts, compareVersions, writtenByVersion, AUTOSTART_SCHEMA_VERSION, APP_VERSION } from './autostart.mjs';

const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsOnly = process.platform === 'win32' ? {} : { skip: 'Windows only' };

test('normalizeAutostart accepts only two booleans', () => {
  assert.deepEqual(normalizeAutostart({ service: true, relay: false }), { service: true, relay: false });
  for (const bad of [null, {}, { service: 'yes', relay: false }, { service: true }, { service: true, relay: 1 }, { service: 1, relay: 0 }]) {
    assert.throws(() => normalizeAutostart(bad), /自動啟動設定格式不正確/);
  }
  // Unknown keys stay ignored so a newer page can talk to an older service.
  assert.deepEqual(normalizeAutostart({ service: true, relay: false, extra: 1 }), { service: true, relay: false });
});

test('store persists preferences atomically and reports missing files as disabled', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(home, { recursive: true, force: true })));
  const store = createAutostartStore(home, { apply: async () => {} });
  assert.deepEqual(await store.load(), { service: false, relay: false });
  assert.deepEqual(await store.save({ service: true, relay: false }), { service: true, relay: false });
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'LinePort', 'autostart.json'), 'utf8')), { service: true, relay: false, schemaVersion: AUTOSTART_SCHEMA_VERSION, writtenByVersion: APP_VERSION });
  assert.deepEqual(await store.load(), { service: true, relay: false });
  const applied = [];
  const recording = createAutostartStore(home, { apply: async value => { applied.push(value); } });
  await recording.save({ service: false, relay: true });
  assert.deepEqual(applied, [{ service: false, relay: true }]);
});

test('writeAutostartScripts writes idempotent hidden entrypoints', { skip: windowsOnly.skip }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(home, { recursive: true, force: true })));
  const first = await writeAutostartScripts(home);
  const second = await writeAutostartScripts(home);
  assert.equal(first.serviceScript, second.serviceScript);
  for (const script of [first.serviceScript, first.relayScript]) {
    const content = await readFile(script, 'utf8');
    assert.ok(!content.includes('node_modules'));
  }
  assert.match(await readFile(first.serviceScript, 'utf8'), /LinePort\.exe/);
  const relay = await readFile(first.relayScript, 'utf8');
  assert.match(relay, /api\/relay\/status/);
  assert.match(relay, /api\/status/);
  assert.match(relay, /api\/resume/);
  assert.match(relay, /api\/relay\/start/);
  assert.match(relay, /useRules/);
  // The token travels from the served page inside the same hidden process; no secrets are written.
  assert.ok(!relay.includes('X-Probe-Token: '));
  const directory = await readdir(path.join(home, 'LinePort'));
  assert.deepEqual(directory.sort(), ['autostart-relay.ps1', 'autostart-service.ps1']);
});

test('relay autostart resumes the saved session before starting rules', { skip: windowsOnly.skip }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-behavior-'));
  const { relayScript } = await writeAutostartScripts(home);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const cases = [
    ['idle', ['/api/relay/status', '/api/status', '/api/resume', '/api/relay/start']],
    ['connected', ['/api/relay/status', '/api/status', '/api/relay/start']],
    ['resume-fails', ['/api/relay/status', '/api/status', '/api/resume', '/api/relay/start']],
    ['running', ['/api/relay/status']],
  ];
  for (const [scenario, expected] of cases) {
    const command = `
$scenario = '${scenario}'
function Invoke-WebRequest {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  return [pscustomobject]@{ Content = "const token='" + ('a' * 64) + "'" }
}
function Invoke-RestMethod {
  param($Uri, $Method, $Headers, $ContentType, $Body, $TimeoutSec)
  $endpoint = ([uri]$Uri).AbsolutePath
  Write-Host "CALL:$endpoint"
  switch ($endpoint) {
    '/api/relay/status' { return [pscustomobject]@{ phase = $(if ($scenario -eq 'running') { 'running' } else { 'stopped' }) } }
    '/api/status' { return [pscustomobject]@{ connected = ($scenario -eq 'connected'); busy = $false; phase = 'idle' } }
    '/api/resume' { if ($scenario -eq 'resume-fails') { throw 'No saved LINE session' }; return @{} }
    '/api/relay/start' { if ($Body -ne '{"useRules":true}') { throw 'Expected saved rules' }; return @{} }
    default { throw "Unexpected endpoint: $endpoint" }
  }
}
. '${relayScript.replaceAll("'", "''")}'
`;
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 15000 });
    const calls = stdout.split(/\r?\n/).filter(line => line.startsWith('CALL:')).map(line => line.slice(5));
    assert.deepEqual(calls, expected, scenario);
  }
});

test('applyAutostartShortcuts creates and removes only its own two shortcuts', { skip: windowsOnly.skip }, async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-')));
  const appData = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lineport-appdata-')));
  t.after(() => import('node:fs/promises').then(fs => { fs.rm(home, { recursive: true, force: true }); fs.rm(appData, { recursive: true, force: true }); }));
  const previousAppData = process.env.APPDATA, previousLocal = process.env.LOCALAPPDATA;
  process.env.APPDATA = appData; process.env.LOCALAPPDATA = home;
  t.after(() => { process.env.APPDATA = previousAppData; process.env.LOCALAPPDATA = previousLocal; });
  // A launcher must exist beside the scripts for the runtime check in real runs; applyAutostartShortcuts
  // itself only writes scripts and shortcuts, so provide the payload root the scripts expect.
  await mkdir(path.join(home, 'LinePort'), { recursive: true });
  await writeFile(path.join(home, 'LinePort', 'LinePort.exe'), 'stub');
  const results = await applyAutostartShortcuts({ service: true, relay: true }, home, { powershell: shell });
  assert.deepEqual(results, [{ kind: 'service', enabled: true }, { kind: 'relay', enabled: true }]);
  const startup = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const created = (await readdir(startup)).filter(name => name.endsWith('.lnk'));
  assert.equal(created.length, 2);
  assert.ok(created.includes('LinePort 自動啟動.lnk'));
  assert.ok(created.includes('LinePort 自動啟動 轉送.lnk'));
  await applyAutostartShortcuts({ service: true, relay: false }, home, { powershell: shell });
  const remaining = (await readdir(startup)).filter(name => name.endsWith('.lnk')).sort();
  assert.deepEqual(remaining, ['LinePort 自動啟動.lnk']);
  await applyAutostartShortcuts({ service: false, relay: false }, home, { powershell: shell });
  assert.deepEqual((await readdir(startup)).filter(name => name.endsWith('.lnk')), []);
});

test('shortcut arguments point at the generated scripts with a hidden window', { skip: windowsOnly.skip }, async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-')));
  const appData = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lineport-appdata-')));
  t.after(() => import('node:fs/promises').then(fs => { fs.rm(home, { recursive: true, force: true }); fs.rm(appData, { recursive: true, force: true }); }));
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = appData;
  t.after(() => { process.env.APPDATA = previousAppData; });
  await mkdir(path.join(home, 'LinePort'), { recursive: true });
  await writeFile(path.join(home, 'LinePort', 'LinePort.exe'), 'stub');
  await applyAutostartShortcuts({ service: true, relay: true }, home, { powershell: shell });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const startup = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  for (const name of ['LinePort 自動啟動.lnk', 'LinePort 自動啟動 轉送.lnk']) {
    const lnk = path.join(startup, name);
    await stat(lnk);
    // WScript.Shell.CreateShortcut cannot open non-ACP filenames on English Windows; inspect via an ASCII copy.
    const asciiCopy = path.join(startup, 'inspect-shortcut.lnk');
    await copyFile(lnk, asciiCopy);
    const { stdout } = await run(shell, [`-NoProfile`, `-NonInteractive`, `-Command`,
      `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut(${JSON.stringify(asciiCopy)}); Write-Output ($s.TargetPath + '|' + $s.Arguments + '|' + $s.WorkingDirectory)`], { windowsHide: true, timeout: 30000 });
    await unlink(asciiCopy);
    const [target, args, working] = String(stdout).trim().split('|');
    assert.equal(target.toLowerCase(), shell.toLowerCase());
    assert.match(args, /-WindowStyle Hidden -File /);
    assert.ok(args.includes(path.join(home, 'LinePort')), 'shortcut should run the generated script');
    assert.equal(working, path.join(home, 'LinePort'));
  }
});

const execute = async (args, options = {}) => {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => execFile(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 30000, ...options },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
};
const temporaryHome = async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-v2-')));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(home, { recursive: true, force: true })));
  return home;
};

test('versions compare like upgrade-service.ps1, with release candidates below the release', () => {
  assert.equal(compareVersions('1.0.2', '1.0.2'), 0);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.1.0-rc.2', '1.1.0'), -1);
  assert.equal(compareVersions('1.1.0-rc.10', '1.1.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.2'), -1);
  assert.throws(() => compareVersions('1.0', '1.0.0'));
});

test('preference and scripts record their writer, and an older release cannot overwrite them', async t => {
  const home = await temporaryHome(t);
  const newer = createAutostartStore(home, { version: '1.1.0' });
  await newer.save({ service: true, relay: true });
  const scripts = await writeAutostartScripts(home, { version: '1.1.0' });
  for (const file of [scripts.serviceScript, scripts.relayScript]) {
    const content = await readFile(file, 'utf8');
    assert.ok(content.startsWith('\uFEFF'), 'BOM keeps non-ASCII paths readable by Windows PowerShell 5.1');
    assert.match(content, /^# schemaVersion: 2$/m);
    assert.match(content, /^# writtenByVersion: 1\.1\.0$/m);
    assert.match(content, /autostart\.log/);
    assert.ok(!/[a-f0-9]{64}/.test(content), 'no token value is ever written into a script');
  }
  assert.equal(await writtenByVersion(home), '1.1.0');
  await assert.rejects(createAutostartStore(home, { version: '1.0.2' }).save({ service: false, relay: false }), /較新的 LinePort v1\.1\.0/);
  await assert.rejects(writeAutostartScripts(home, { version: '1.1.0-rc.1' }), /較新的 LinePort v1\.1\.0/);
  assert.deepEqual(await newer.load(), { service: true, relay: true }, 'blocked writes leave the newer preference intact');
  await writeAutostartScripts(home, { version: '1.1.1' });
  assert.equal(await writtenByVersion(home), '1.1.1');
});

test('startup refresh repairs scripts left by an older release but never touches newer ones', async t => {
  const home = await temporaryHome(t);
  const directory = path.join(home, 'LinePort');
  assert.equal(await refreshAutostartScripts(home, { version: '1.1.0' }), false, 'autostart disabled');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'autostart.json'), JSON.stringify({ service: true, relay: false }));
  await writeFile(path.join(directory, 'autostart-service.ps1'), "$launcher = 'C:\\broken\\LinePort.exe'\n");
  await writeFile(path.join(directory, 'autostart-relay.ps1'), '# legacy\n');
  assert.equal(await refreshAutostartScripts(home, { version: '1.1.0' }), true);
  assert.match(await readFile(path.join(directory, 'autostart-service.ps1'), 'utf8'), /writtenByVersion: 1\.1\.0/);
  assert.equal(await refreshAutostartScripts(home, { version: '1.1.0' }), false, 'already current');
  await assert.rejects(refreshAutostartScripts(home, { version: '1.0.2' }), /較新的/);
  assert.match(await readFile(path.join(directory, 'autostart-service.ps1'), 'utf8'), /writtenByVersion: 1\.1\.0/);
});

test('relay intent is stored atomically for the watchdog', async t => {
  const home = await temporaryHome(t);
  const store = createAutostartStore(home);
  await store.saveRelayIntent('stopped');
  assert.equal(JSON.parse(await readFile(path.join(home, 'LinePort', 'relay-intent.json'), 'utf8')).desired, 'stopped');
  await assert.rejects(store.saveRelayIntent('maybe'));
});

test('a failing hidden service entrypoint logs the reason and keeps only the last 200 lines', { skip: windowsOnly.skip }, async t => {
  const home = await temporaryHome(t);
  const { serviceScript } = await writeAutostartScripts(home, { appRoot: path.join(home, 'missing-portable') });
  const log = path.join(home, 'LinePort', 'autostart.log');
  await writeFile(log, Array.from({ length: 250 }, (_, index) => `old ${index}`).join('\r\n') + '\r\n');
  const result = await execute(['-File', serviceScript]);
  assert.equal(result.code, 1);
  const lines = (await readFile(log, 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  assert.equal(lines.length, 200);
  assert.equal(lines[0], 'old 51');
  assert.match(lines.at(-1), /\[service v\d+\.\d+\.\d+\S*\] failed: .*LinePort\.exe not found/);
});

test('installed launcher picks the highest version folder, not the most recently touched one', { skip: windowsOnly.skip }, async t => {
  const home = await temporaryHome(t);
  const versions = path.join(home, 'Programs', 'LinePort', 'versions');
  for (const name of ['1.0.2-20261123121009', '1.0.10-20261101000000', '1.1.0-rc.3-20261124000000', '1.0.2-20261123121108', 'junk']) {
    await mkdir(path.join(versions, name), { recursive: true });
    await writeFile(path.join(versions, name, 'LinePort.exe'), '');
  }
  await import('node:fs/promises').then(fs => fs.utimes(path.join(versions, '1.0.2-20261123121009'), new Date(), new Date(Date.now() + 86400000)));
  const { serviceScript } = await writeAutostartScripts(home, { appRoot: path.join(versions, '1.0.2-20261123121009') });
  const command = `function Start-Process { param($FilePath, $WorkingDirectory, $WindowStyle) Write-Output "LAUNCH:$FilePath" }\n. '${serviceScript.replaceAll("'", "''")}'`;
  const result = await execute(['-Command', command], { env: { ...process.env, LOCALAPPDATA: home } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).find(line => line.startsWith('LAUNCH:')), `LAUNCH:${path.join(versions, '1.1.0-rc.3-20261124000000', 'LinePort.exe')}`);
  assert.match(await readFile(path.join(home, 'LinePort', 'autostart.log'), 'utf8'), /started service launcher/);
});
