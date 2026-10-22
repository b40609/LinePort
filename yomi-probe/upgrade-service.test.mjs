import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const run = command => execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 20000 });

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lineport-upgrade-'));
  const old = path.join(temporary, 'old version');
  const target = path.join(temporary, 'new version');
  for (const directory of [old, target]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'lineport', version: directory === old ? '0.8.6' : '0.8.7' }));
    await writeFile(path.join(directory, 'server.mjs'), 'export {};');
    await writeFile(path.join(directory, 'relay.mjs'), 'export {};');
  }
  for (const file of ['@rikaidev/yomi/dist/line/core/service.js', 'qrcode/lib/index.js', 'tweetnacl/nacl-fast.js']) {
    const destination = path.join(target, 'node_modules', file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, '// synthetic dependency fixture');
  }
  const html = `<span>v0.8.6 · LINE</span><script>const token='${'a'.repeat(64)}';</script>`;
  const mocks = `$ErrorActionPreference='Stop'
. ${quote(path.join(root, 'upgrade-service.ps1'))}
$global:ui=$true; $global:relay=$true; $global:stopCalls=0; $global:apiCalls=0
function Get-NetTCPConnection { param($LocalAddress,$LocalPort,$State,$ErrorAction)
 if($LocalPort -eq 18765 -and $global:ui) { [pscustomobject]@{OwningProcess=123} }
 if($LocalPort -eq 18766 -and $global:relay) { [pscustomobject]@{OwningProcess=124} }
}
function Get-CimInstance { param($ClassName,$Filter)
 $entry=if($Filter -eq 'ProcessId = 123') {'server.mjs'} else {'relay.mjs'}
 [pscustomobject]@{Name='node.exe';ProcessId=if($entry -eq 'server.mjs'){123}else{124};CommandLine='"${process.execPath}" "'+(Join-Path ${quote(old)} $entry)+'"'}
}
function Invoke-RestMethod { param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec)
 if($Uri -eq 'http://127.0.0.1:18765/api/status' -and $Method -eq 'Get') { return [pscustomobject]@{busy=$false;phase='connected'} }
 if($Uri -ne 'http://127.0.0.1:18765/api/relay/stop' -or $Headers['X-Probe-Token'] -ne '${'a'.repeat(64)}' -or $Method -ne 'Post') { throw 'Invalid stop request' }
 $global:apiCalls++; $global:relay=$false
}
function Stop-Process { param($Id,$ErrorAction)
 if($global:relay -or $Id -ne 123) { throw 'Unsafe stop' }
 $global:stopCalls++; $global:ui=$false
}
function Start-Sleep { }
`;
  return { old, target, html, mocks };
}

test('upgrade verifies old ownership, stops relay first and replaces UI across extracted folders', { skip: process.platform !== 'win32' }, async () => {
  const { mocks, target, html } = await fixture();
  const { stdout } = await run(`${mocks}
if (!(Update-LinePortService ${quote(html)} ${quote(target)})) { throw 'Update not selected' }
if($global:apiCalls -ne 1 -or $global:stopCalls -ne 1) { throw 'Incorrect stop counts' }
Write-Output 'upgraded'`);
  assert.match(stdout, /upgraded/);
});

test('upgrade preserves an idle relay and UI during phone authorization', { skip: process.platform !== 'win32' }, async () => {
  const { mocks, target, html } = await fixture();
  const { stdout } = await run(`${mocks}
$global:relay=$false
function Invoke-RestMethod { [pscustomobject]@{busy=$true;phase='waiting_pin'} }
try { Update-LinePortService ${quote(html)} ${quote(target)}; throw 'Expected busy rejection' } catch { if($_ -notmatch 'authorization is in progress') { throw } }
if(!$global:ui -or $global:stopCalls) { throw 'Old UI was stopped' }
Write-Output 'retained'`);
  assert.match(stdout, /retained/);
});

test('release candidates compare below the final release and use numeric candidate ordering', { skip: process.platform !== 'win32' }, async () => {
  const { stdout } = await run(`. ${quote(path.join(root, 'upgrade-service.ps1'))}
if((Compare-LinePortVersion '0.8.7' '1.0.0-rc.1') -ge 0) { throw 'Upgrade blocked' }
if((Compare-LinePortVersion '1.0.0-rc.9' '1.0.0-rc.10') -ge 0) { throw 'Candidate ordering invalid' }
if((Compare-LinePortVersion '1.0.0' '1.0.0-rc.1') -le 0) { throw 'Final release can be downgraded' }
if((Compare-LinePortVersion '1.0.0-rc.1' '1.0.0') -ge 0) { throw 'Final upgrade blocked' }
Write-Output 'ordered'`);
  assert.match(stdout, /ordered/);
});

test('upgrade preserves old UI when stopping relay fails', { skip: process.platform !== 'win32' }, async () => {
  const { mocks, target, html } = await fixture();
  const { stdout } = await run(`${mocks}
function Invoke-RestMethod { param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec)
 if($Method -eq 'Get') { return [pscustomobject]@{busy=$false;phase='connected'} }
 throw 'Relay stop fixture failure'
}
try { Update-LinePortService ${quote(html)} ${quote(target)}; throw 'Expected stop rejection' } catch { if($_ -notmatch 'Relay stop fixture failure') { throw } }
if(!$global:ui -or $global:stopCalls) { throw 'Old UI was stopped' }
Write-Output 'retained'`);
  assert.match(stdout, /retained/);
});

test('upgrade blocks unrelated entrypoints, extra arguments and missing replacement dependencies', { skip: process.platform !== 'win32' }, async () => {
  const { mocks, target, html } = await fixture();
  for (const command of ['node.exe unrelated.mjs', `"${process.execPath}" "${path.join(target, 'server.mjs')}" --extra`]) {
    await assert.rejects(run(`${mocks}
function Get-CimInstance { [pscustomobject]@{Name='node.exe';CommandLine=${quote(command)}} }
Update-LinePortService ${quote(html)} ${quote(target)}`), /unrecognized|Unrecognized/);
  }
  const { stdout } = await run(`${mocks}
function Test-Path { param($LiteralPath) return $LiteralPath -notlike '*node_modules*' }
try { Update-LinePortService ${quote(html)} ${quote(target)}; throw 'Expected incomplete package' } catch { if($_ -notmatch 'incomplete') { throw } }
if($global:stopCalls -or $global:apiCalls) { throw 'Old service was changed' }
Write-Output 'retained'`);
  assert.match(stdout, /retained/);
});

test('upgrade blocks downgrade and reuses the same release in the same folder', { skip: process.platform !== 'win32' }, async () => {
  const { mocks, old, target, html } = await fixture();
  await assert.rejects(run(`${mocks}
Update-LinePortService ${quote(html.replace('0.8.6', '0.8.8'))} ${quote(target)}`), /downgrade was blocked/);
  const { stdout } = await run(`${mocks}
if(Update-LinePortService ${quote(html)} ${quote(old)}) { throw 'Unexpected update' }
if($global:stopCalls -or $global:apiCalls) { throw 'Running service was changed' }
Write-Output 'reused'`);
  assert.match(stdout, /reused/);
});
