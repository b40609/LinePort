import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only' };
const root = path.dirname(fileURLToPath(import.meta.url));
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const token = 'b'.repeat(64);

function run(script, args) {
  return new Promise(resolve => execFile(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, script), ...args],
    { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
}
async function fakeUi(t, phase) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<title>LinePort</title><script>const token='${token}';</script>`); return; }
    if (req.url === '/api/diagnostics' && req.headers['x-probe-token'] === token) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ phase })); return; }
    res.writeHead(403); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
async function deadUrl() {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address(); await new Promise(resolve => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
async function home(t, { autostart = { service: true, relay: true }, intent, scripts = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-watchdog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (autostart) await writeFile(path.join(directory, 'autostart.json'), JSON.stringify(autostart));
  if (intent) await writeFile(path.join(directory, 'relay-intent.json'), JSON.stringify({ desired: intent }));
  if (scripts) for (const name of ['autostart-service.ps1', 'autostart-relay.ps1']) await writeFile(path.join(directory, name), '# synthetic');
  return directory;
}
const logOf = async directory => { try { return (await readFile(path.join(directory, 'watchdog.log'), 'utf8')).replace(/^\uFEFF/, ''); } catch { return ''; } };
const watchdog = (directory, url, extra = []) => run('watchdog.ps1', ['-LinePortHome', directory, '-BaseUrl', url, '-DryRun', ...extra]);

test('watchdog stays silent when autostart is off or everything is healthy', windowsOnly, async t => {
  const off = await home(t, { autostart: null });
  assert.equal((await watchdog(off, await deadUrl())).code, 0);
  assert.equal(await logOf(off), '');
  const ui = await fakeUi(t, 'running');
  const healthy = await home(t);
  assert.equal((await watchdog(healthy, ui.url)).code, 0);
  assert.equal(await logOf(healthy), '');
  assert.deepEqual(ui.seen, ['/', '/api/diagnostics']);
});

test('a dead service restarts both entrypoints; a stopped relay restarts only the relay', windowsOnly, async t => {
  const down = await home(t);
  await watchdog(down, await deadUrl());
  const log = await logOf(down);
  assert.match(log, /recovering: service down, relay unknown/);
  assert.match(log, /\[dry-run\] would start autostart-service\.ps1/);
  assert.match(log, /\[dry-run\] would start autostart-relay\.ps1/);
  const ui = await fakeUi(t, 'stopped');
  const relay = await home(t, { intent: 'running' });
  await watchdog(relay, ui.url);
  const relayLog = await logOf(relay);
  assert.match(relayLog, /recovering: service up, relay stopped/);
  assert.doesNotMatch(relayLog, /autostart-service/);
  assert.match(relayLog, /would start autostart-relay\.ps1/);
  assert.ok(!relayLog.includes(token));
});

test('a manual stop, a failed relay needing review, or relay autostart off are left alone', windowsOnly, async t => {
  const stopped = await fakeUi(t, 'stopped');
  for (const options of [{ intent: 'stopped' }, { autostart: { service: true, relay: false } }]) {
    const directory = await home(t, options);
    await watchdog(directory, stopped.url);
    assert.equal(await logOf(directory), '', JSON.stringify(options));
  }
  const failed = await fakeUi(t, 'failed');
  const directory = await home(t);
  await watchdog(directory, failed.url);
  assert.equal(await logOf(directory), '');
});

test('the circuit breaker allows three restarts per window and logs once when it opens', windowsOnly, async t => {
  const directory = await home(t), url = await deadUrl();
  for (let index = 0; index < 5; index++) assert.equal((await watchdog(directory, url)).code, 0);
  const log = await logOf(directory);
  assert.equal(log.match(/recovering:/g).length, 3);
  assert.equal(log.match(/circuit open/g).length, 1);
  const state = JSON.parse((await readFile(path.join(directory, 'watchdog-state.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(state.restarts.length, 3);
});

test('missing entrypoints are reported instead of failing silently', windowsOnly, async t => {
  const directory = await home(t, { scripts: false });
  await watchdog(directory, await deadUrl());
  assert.match(await logOf(directory), /missing autostart-service\.ps1/);
  assert.equal(await readFile(path.join(directory, 'watchdog-state.json'), 'utf8').catch(() => ''), '', 'nothing started, nothing counted');
});

test('task installer dry run describes logon and 5-minute triggers without touching Task Scheduler', windowsOnly, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-watchdog-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await run('install-watchdog.ps1', ['-LinePortHome', path.join(directory, 'LinePort'), '-TaskName', 'LinePort-Test-DryRun', '-DryRun']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /would register task LinePort-Test-DryRun/);
  assert.match(result.stdout, /AtLogOn; every 5 minutes/);
  assert.match(result.stdout, /watchdog\.ps1/);
  await assert.rejects(readFile(path.join(directory, 'LinePort', 'watchdog.ps1')), 'dry run copies nothing');
  const uninstall = await run('install-watchdog.ps1', ['-TaskName', 'LinePort-Test-DryRun', '-Uninstall', '-DryRun']);
  assert.match(uninstall.stdout, /would unregister task LinePort-Test-DryRun/);
});

test('watchdog scripts parse without errors in Windows PowerShell', windowsOnly, async () => {
  for (const script of ['watchdog.ps1', 'install-watchdog.ps1']) {
    const command = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, script)}', [ref]$null, [ref]$errors) | Out-Null; if ($errors) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    const result = await new Promise(resolve => execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
    assert.equal(result.code, 0, `${script}: ${result.stdout}`);
  }
});
