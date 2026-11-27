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

test('the circuit breaker allows three restarts per window and logs and notifies once when it opens', windowsOnly, async t => {
  const directory = await home(t), url = await deadUrl();
  for (let index = 0; index < 5; index++) assert.equal((await watchdog(directory, url)).code, 0);
  const log = await logOf(directory);
  assert.equal(log.match(/recovering:/g).length, 3);
  assert.equal(log.match(/circuit open/g).length, 1);
  assert.equal(log.match(/\[dry-run\] would notify: LinePort 看門狗已暫停自動重啟/g).length, 1);
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

test('watchdog and prune scripts parse without errors in Windows PowerShell', windowsOnly, async () => {
  const watchdogRaw = await readFile(path.join(root, 'watchdog.ps1'), 'utf8');
  assert.ok(watchdogRaw.startsWith('\uFEFF'), 'watchdog.ps1 must carry UTF-8 BOM for Windows PowerShell 5.1 Chinese strings');
  for (const script of ['watchdog.ps1', 'install-watchdog.ps1', 'prune-versions.ps1']) {
    const command = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, script)}', [ref]$null, [ref]$errors) | Out-Null; if ($errors) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    const result = await new Promise(resolve => execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
    assert.equal(result.code, 0, `${script}: ${result.stdout}`);
  }
});

test('prune-versions keeps current and previous complete versions, removes older and stale incomplete ones, and rejects unsafe paths', windowsOnly, async t => {
  const { utimes } = await import('node:fs/promises');
  const base = await mkdtemp(path.join(os.tmpdir(), 'lineport-prune-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const versions = path.join(base, 'versions');
  await mkdir(versions, { recursive: true });
  const makeComplete = async name => {
    await mkdir(path.join(versions, name, 'yomi-probe'), { recursive: true });
    await writeFile(path.join(versions, name, 'LinePort.exe'), '');
    await writeFile(path.join(versions, name, 'yomi-probe', 'package.json'), '{}');
  };
  for (const name of ['1.0.0-rc.2-20261022095752', '1.0.0-rc.3-20261029124805', '1.0.2-20261123121108', '1.1.0-20261123173000']) {
    await makeComplete(name);
  }
  // Stale incomplete install residue (2 hours old) and fresh incomplete folder (should be spared).
  const stalePartial = path.join(versions, '1.0.2-20261123121009');
  const freshPartial = path.join(versions, '1.1.0-20261123173100');
  const unrelated = path.join(versions, 'keep-unrelated');
  for (const dir of [stalePartial, freshPartial, unrelated]) await mkdir(dir, { recursive: true });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  await utimes(stalePartial, twoHoursAgo, twoHoursAgo);

  const rejected = await run('prune-versions.ps1', ['-VersionsRoot', base, '-DryRun']);
  assert.notEqual(rejected.code, 0, 'must refuse non-versions directory');

  const dry = await run('prune-versions.ps1', ['-VersionsRoot', versions, '-CurrentDirectory', path.join(versions, '1.1.0-20261123173000'), '-Keep', '2', '-DryRun']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would remove: 1\.0\.0-rc\.3-20261029124805/);
  assert.match(dry.stdout, /would remove: 1\.0\.0-rc\.2-20261022095752/);
  assert.match(dry.stdout, /would remove: 1\.0\.2-20261123121009/);
  assert.doesNotMatch(dry.stdout, /1\.1\.0-20261123173000/);
  assert.doesNotMatch(dry.stdout, /1\.0\.2-20261123121108/);
  assert.doesNotMatch(dry.stdout, /1\.1\.0-20261123173100/);
  assert.doesNotMatch(dry.stdout, /keep-unrelated/);

  const applied = await run('prune-versions.ps1', ['-VersionsRoot', versions, '-CurrentDirectory', path.join(versions, '1.1.0-20261123173000'), '-Keep', '2']);
  assert.equal(applied.code, 0, applied.stderr);
  const { readdir } = await import('node:fs/promises');
  const remaining = (await readdir(versions)).sort();
  assert.deepEqual(remaining, ['1.0.2-20261123121108', '1.1.0-20261123173000', '1.1.0-20261123173100', 'keep-unrelated']);
});

// Review 2026-11-27 P1-1/P1-2: replay the real 5-minute Task Scheduler cadence. Every run is one tick;
// between ticks all timestamps in watchdog-state.json are moved back by the tick length, which is what
// the script would observe had the wall clock advanced.
async function switchableUi(t, initial) {
  let phase = initial;
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<title>LinePort</title><script>const token='${token}';</script>`); return; }
    if (req.url === '/api/diagnostics' && req.headers['x-probe-token'] === token) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ phase })); return; }
    res.writeHead(403); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, set: value => { phase = value; } };
}
const statePathOf = directory => path.join(directory, 'watchdog-state.json');
async function readState(directory) {
  try { return JSON.parse((await readFile(statePathOf(directory), 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}
// Same shape as PowerShell's ToString('o') on local time (offset kept), so parsing round-trips unchanged.
function localIso(ms) {
  const date = new Date(ms), offset = -date.getTimezoneOffset(), pad = (value, size = 2) => String(Math.abs(value)).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
async function ageState(directory, seconds) {
  const state = await readState(directory);
  if (!state) return;
  const shift = value => {
    if (Array.isArray(value)) return value.map(shift);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item)]));
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) && !Number.isNaN(Date.parse(value))) return localIso(Date.parse(value) - seconds * 1000);
    return value;
  };
  await writeFile(statePathOf(directory), JSON.stringify(shift(state)));
}
async function onSchedule(directory, url, ticks, { seconds = 300, extra = [] } = {}) {
  for (let index = 0; index < ticks; index++) {
    assert.equal((await watchdog(directory, url, extra)).code, 0);
    await ageState(directory, seconds);
  }
  const log = await logOf(directory);
  const count = pattern => (log.match(pattern) || []).length;
  return { log, stopHung: count(/would stop hung relay/g), started: count(/would start autostart-relay\.ps1/g), circuit: count(/circuit open/g), notified: count(/would notify: LinePort 看門狗已暫停自動重啟/g) };
}
const stopStub = async directory => { const file = path.join(directory, 'stop-relay-stub.ps1'); await writeFile(file, '# synthetic stop'); return ['-StopRelayScript', file]; };

test('P1-1: a relay that stays hung on the 5-minute schedule is restarted a bounded number of times, then the circuit opens once', windowsOnly, async t => {
  const ui = await switchableUi(t, 'unavailable');
  const directory = await home(t, { intent: 'running' });
  const result = await onSchedule(directory, ui.url, 12, { extra: await stopStub(directory) });
  assert.ok(result.stopHung >= 1 && result.stopHung <= 2, `hung restarts must be capped, saw ${result.stopHung}`);
  assert.equal(result.circuit, 1, 'circuit must open exactly once in one hour of hung checks');
  assert.equal(result.notified, 1);
});

test('P1-1: a relay found stopped on every 5-minute check (exact or jittered cadence) stops being restarted after the limit', windowsOnly, async t => {
  for (const seconds of [300, 290, 310]) {
    const ui = await switchableUi(t, 'stopped');
    const directory = await home(t, { intent: 'running' });
    const result = await onSchedule(directory, ui.url, 12, { seconds });
    assert.ok(result.started <= 3, `cadence ${seconds}s: restarts must stop at the limit, saw ${result.started}`);
    assert.equal(result.circuit, 1, `cadence ${seconds}s: circuit must open exactly once`);
  }
});

test('P1-2: once the relay is healthy again the watchdog clears the circuit stamp and its failure streaks', windowsOnly, async t => {
  const ui = await switchableUi(t, 'stopped');
  const directory = await home(t, { intent: 'running' });
  await onSchedule(directory, ui.url, 5);
  assert.equal(typeof (await readState(directory))?.circuitLoggedAt, 'string', 'precondition: circuit is open');
  ui.set('running');
  await onSchedule(directory, ui.url, 1);
  const cleared = await readState(directory);
  assert.equal(cleared.circuitLoggedAt ?? null, null, 'healthy check must clear circuitLoggedAt');
  assert.equal(cleared.failStreak, 0);
  assert.match(await logOf(directory), /circuit closed: service and relay are healthy again/);
  // Another outage inside the hour (a flapping relay) reopens the circuit with a fresh notification, never silently.
  ui.set('stopped');
  const flapping = await onSchedule(directory, ui.url, 1);
  assert.equal(flapping.circuit, 2);
  assert.equal(flapping.notified, 2);
  // After a healthy hour the window has aged out and a new outage is restarted normally.
  ui.set('running');
  await onSchedule(directory, ui.url, 12);
  ui.set('stopped');
  const later = await onSchedule(directory, ui.url, 1);
  assert.equal((later.log.match(/recovering: service up, relay stopped/g) || []).length, 4);
});
