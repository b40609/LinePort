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
