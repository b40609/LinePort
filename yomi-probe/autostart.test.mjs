import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeAutostart, createAutostartStore, writeAutostartScripts, applyAutostartShortcuts } from './autostart.mjs';

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
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'LinePort', 'autostart.json'), 'utf8')), { service: true, relay: false });
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
  const home = await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-'));
  const appData = await mkdtemp(path.join(os.tmpdir(), 'lineport-appdata-'));
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
  const home = await mkdtemp(path.join(os.tmpdir(), 'lineport-autostart-'));
  const appData = await mkdtemp(path.join(os.tmpdir(), 'lineport-appdata-'));
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
    const { stdout } = await run(shell, [`-NoProfile`, `-NonInteractive`, `-Command`,
      `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut(${JSON.stringify(lnk)}); Write-Output ($s.TargetPath + '|' + $s.Arguments + '|' + $s.WorkingDirectory)`], { windowsHide: true, timeout: 30000 });
    const [target, args, working] = String(stdout).trim().split('|');
    assert.equal(target.toLowerCase(), shell.toLowerCase());
    assert.match(args, /-WindowStyle Hidden -File /);
    assert.ok(args.includes(path.join(home, 'LinePort')), 'shortcut should run the generated script');
    assert.equal(working, path.join(home, 'LinePort'));
    await stat(lnk);
  }
});
