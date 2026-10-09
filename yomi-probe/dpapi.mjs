import { spawn } from 'node:child_process';
import path from 'node:path';
import { RelayError } from './relay-health.mjs';

// Credentials travel through stdin/stdout pipes, never command arguments or logs.
const script = `$ErrorActionPreference='Stop'; try {
  Add-Type -AssemblyName System.Security;
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json;
  $bytes = [Convert]::FromBase64String($inputData.data);
  $entropy = [Text.Encoding]::UTF8.GetBytes('LinePort.BotToken.v1');
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser;
  if ($inputData.operation -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,$scope);
  } elseif ($inputData.operation -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,$scope);
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result));
} catch { exit 1 }`;

function transform(operation, data) {
  if (process.platform !== 'win32') throw new RelayError('DPAPI 僅限 Windows；請在原 Windows 使用者下保存或重新輸入 Token');
  return new Promise((resolve, reject) => {
    const error = () => new RelayError('Windows Token 保護或解密失敗；原設定保留，請使用原 Windows 帳號，或重新輸入 Bot Token。不要刪改憑證檔');
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const parts = []; let length = 0;
    const timer = setTimeout(() => { child.kill(); reject(error()); }, 15000);
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 16384) { child.kill(); reject(error()); } else parts.push(chunk); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(error()); });
    child.once('close', code => {
      clearTimeout(timer);
      const result = Buffer.concat(parts).toString('ascii').trim();
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) reject(error());
      else resolve(result);
    });
    child.stdin.end(JSON.stringify({ operation, data }));
  });
}
export async function protectToken(token) {
  if (typeof token !== 'string' || !token || token.length > 1024) throw new RelayError('Token 格式不正確');
  return { version: 1, protection: 'dpapi-current-user', data: await transform('protect', Buffer.from(token, 'utf8').toString('base64')) };
}
export async function unprotectToken(record) {
  if (!record || record.version !== 1 || record.protection !== 'dpapi-current-user' || typeof record.data !== 'string' || record.data.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.data)) throw new RelayError('受保護 Token 檔案格式不正確；請保留原檔並重新連結平台');
  const token = Buffer.from(await transform('unprotect', record.data), 'base64').toString('utf8');
  if (!token || token.length > 1024) throw new RelayError('受保護 Token 無法解密；請在原 Windows 使用者下重新連結');
  return token;
}
