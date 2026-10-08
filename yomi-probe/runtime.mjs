import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function prepareDataDirectory() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('Windows LOCALAPPDATA is required');
  const dataDir = path.join(process.env.LOCALAPPDATA, 'LineCallYomiProbe');
  const script = fileURLToPath(new URL('./protect-data.ps1', import.meta.url));
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // No file contents or credentials cross this subprocess boundary.
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 30000 });
  process.env.YOMI_DATA_DIR = dataDir;
  process.env.YOMI_NO_KEYCHAIN = '1';
  return dataDir;
}
