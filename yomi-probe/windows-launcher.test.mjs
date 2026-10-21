import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const run = (command, options = {}) => execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 15000, ...options });

test('launcher recognizes current and previous titles without starting another server', { skip: process.platform !== 'win32' }, async () => {
  for (const title of ['LinePort', 'LINE Relay Bridge']) {
    const { stdout } = await run(`function Invoke-WebRequest { [pscustomobject]@{Content='<title>${title}</title><input id="phone">'} }
function Start-Process { param($FilePath) if ($FilePath -ne 'http://127.0.0.1:18765/') { throw 'Unexpected server launch' }; Write-Output 'opened' }
& ${quote(path.join(root, 'start.ps1'))}`);
    assert.match(stdout, /opened/);
  }
});

test('launcher reuses the running mode unless an explicit device conflicts', { skip: process.platform !== 'win32' }, async () => {
  for (const device of ['IOSIPAD', 'DESKTOPWIN']) {
  const mocks = `function Invoke-WebRequest { [pscustomobject]@{Content='<title>LinePort</title><input id="phone"><meta name="lineport-device" content="${device}">'} }
function Start-Process { param($FilePath) if ($FilePath -ne 'http://127.0.0.1:18765/') { throw 'Unexpected server launch' }; Write-Output 'opened' }`;
  const reused = await run(`${mocks}\n& ${quote(path.join(root, 'start.ps1'))}`);
  assert.match(reused.stdout, /opened/);
  await assert.rejects(run(`${mocks}\n& ${quote(path.join(root, 'start.ps1'))} -Device DESKTOPMAC`), /Different LINE device/);
  const { stdout } = await run(`${mocks}\n& ${quote(path.join(root, 'start.ps1'))} -Device ${device}`);
  assert.match(stdout, /opened/);
  }
  await assert.rejects(run(`function Invoke-WebRequest { [pscustomobject]@{Content='<title>LinePort</title><input id="phone">'} }
function Start-Process { throw 'Unexpected launch' }
& ${quote(path.join(root, 'start.ps1'))} -Device IOSIPAD`), /Different LINE device/);
});

test('launcher passes iPad profile to the child and restores its own environment', { skip: process.platform !== 'win32' }, async () => {
  const { stdout } = await run(`$ErrorActionPreference='Stop'
$env:LINEPORT_LINE_DEVICE='DESKTOPMAC'
$global:probeCalls=0
function Invoke-WebRequest { $global:probeCalls++; if($global:probeCalls -eq 1) { throw 'offline fixture' }; [pscustomobject]@{Content='<title>LinePort</title><input id="phone"><meta name="lineport-device" content="IOSIPAD">'} }
function Start-Sleep {}
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
 if($FilePath -eq 'http://127.0.0.1:18765/') { return }
 if($env:LINEPORT_LINE_DEVICE -ne 'IOSIPAD' -or $WindowStyle -ne 'Hidden') { throw 'Incorrect launch settings' }
 Write-Output 'inherited'
}
& ${quote(path.join(root, 'start.ps1'))} -Device IOSIPAD
if($env:LINEPORT_LINE_DEVICE -ne 'DESKTOPMAC') { throw 'Environment leaked' }`);
  assert.match(stdout, /inherited/);
});

test('launcher reports missing QR dependencies before spawning a server', { skip: process.platform !== 'win32' }, async () => {
  for (const missing of ['qrcode', 'tweetnacl']) {
    await assert.rejects(run(`function Invoke-WebRequest { throw 'offline fixture' }
function Test-Path { param($LiteralPath) return $LiteralPath -notlike '*${missing}*' }
function Start-Process { throw 'Unexpected server launch' }
& ${quote(path.join(root, 'start.ps1'))} -Device IOSIPAD`), /Dependencies missing/);
  }
});

test('relay launcher rejects a desktop relay when requesting iPad', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(run(`$env:LINEPORT_LINE_DEVICE='IOSIPAD'
function Invoke-RestMethod { [pscustomobject]@{app='line-relay-bridge';phase='running';device='DESKTOPMAC'} }
function Start-Process { throw 'Unexpected launch' }
& ${quote(path.join(root, 'start-relay.ps1'))}`), /Different LINE device/);
});

test('UI stop refuses active relay and unrelated processes, and stops only its own entrypoint', { skip: process.platform !== 'win32' }, async () => {
  const stop = quote(path.join(root, 'stop-server.ps1'));
  await assert.rejects(run(`function Get-NetTCPConnection { [pscustomobject]@{OwningProcess=123} }
function Stop-Process { throw 'Unexpected stop' }
& ${stop}`), /Stop the relay/);
  const listener = `function Get-NetTCPConnection { param($LocalAddress,$LocalPort,$State,$ErrorAction) if($LocalPort -eq 18765) { [pscustomobject]@{OwningProcess=123} } }`;
  await assert.rejects(run(`${listener}
function Get-CimInstance { [pscustomobject]@{Name='node.exe';CommandLine='node.exe unrelated.mjs'} }
function Stop-Process { throw 'Unexpected stop' }
& ${stop}`), /another process/);
  const { stdout } = await run(`${listener}
function Get-CimInstance { [pscustomobject]@{Name='node.exe';CommandLine=${quote('"C:\\node.exe" "' + path.join(root, 'server.mjs') + '"')}} }
function Stop-Process { param($Id,$ErrorAction) if($Id -ne 123) { throw 'Wrong process' }; Write-Output 'verified-stop' }
& ${stop}`);
  assert.match(stdout, /verified-stop/);
});

test('UI stop recognizes the unquoted absolute entrypoint used after identity restart', { skip: process.platform !== 'win32' }, async () => {
  const entry = path.join(root, 'server.mjs');
  const commandLine = 'C:\\node.exe ' + (/\s/.test(entry) ? '"' + entry + '"' : entry);
  const mocks = `function Get-NetTCPConnection { param($LocalAddress,$LocalPort,$State,$ErrorAction) if($LocalPort -eq 18765) { [pscustomobject]@{OwningProcess=123} } }
function Stop-Process { param($Id,$ErrorAction) if($Id -ne 123) { throw 'Wrong process' }; Write-Output 'verified-stop' }`;
  const stop = quote(path.join(root, 'stop-server.ps1'));
  const { stdout } = await run(`${mocks}
function Get-CimInstance { [pscustomobject]@{Name='node.exe';CommandLine=${quote(commandLine)}} }
& ${stop}`);
  assert.match(stdout, /verified-stop/);
  for (const suffix of ['.other', ' --unexpected']) {
    await assert.rejects(run(`${mocks}
function Get-CimInstance { [pscustomobject]@{Name='node.exe';CommandLine=${quote(commandLine + suffix)}} }
& ${stop}`), /another process/);
  }
});

test('data protection changes only access rules and is repeatable without admin privileges', { skip: process.platform !== 'win32' }, async () => {
  // Retain isolated synthetic fixtures in the OS temp directory; never use real login data.
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lineport-acl-'));
  const data = path.join(temporary, 'LineCallYomiProbe');
  await mkdir(path.join(data, 'nested'), { recursive: true });
  await writeFile(path.join(data, 'nested', 'synthetic.txt'), 'synthetic fixture');
  const { stdout } = await run(`$ErrorActionPreference='Stop'
$before=(Get-Item -LiteralPath ${quote(data)}).GetAccessControl().Owner
& ${quote(path.join(root, 'protect-data.ps1'))}
& ${quote(path.join(root, 'protect-data.ps1'))}
$expected=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')
$items=@(Get-Item -LiteralPath ${quote(data)})+@(Get-ChildItem -LiteralPath ${quote(data)} -Recurse -Force)
foreach($item in $items) {
 $acl=$item.GetAccessControl()
 if (!$acl.AreAccessRulesProtected) { throw 'Inherited rules remain' }
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if ($rules.Count -ne 2) { throw 'Unexpected rule count' }
 foreach($rule in $rules) { if($rule.IdentityReference.Value -notin $expected -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected permissions' } }
}
if ((Get-Item -LiteralPath ${quote(data)}).GetAccessControl().Owner -ne $before) { throw 'Owner changed' }
Write-Output 'verified'`, { env: { ...process.env, LOCALAPPDATA: temporary } });
  assert.match(stdout, /verified/);
});
