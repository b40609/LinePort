import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { saveLauncherDevice } from './launcher-preference.mjs';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./upgrade-service.ps1', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function selected(directory) {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. ${quote(helper)}; Get-LinePortPreferredDevice`], {
    env: { ...process.env, LOCALAPPDATA: directory }, windowsHide: true, timeout: 15000,
  });
  return stdout.trim();
}

test('cold launcher retains each explicit identity across fresh processes without credentials', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-device-choice-'));
  assert.equal(await selected(directory), 'DESKTOPMAC');
  for (const device of ['IOSIPAD', 'DESKTOPMAC', 'DESKTOPWIN']) {
    await saveLauncherDevice(device, directory);
    assert.equal(await selected(directory), device);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'LinePort/launcher-device.json'), 'utf8')), { device });
  }
});

test('invalid device never replaces the previous choice; corrupt preference blocks silent fallback', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-device-invalid-'));
  await saveLauncherDevice('IOSIPAD', directory);
  await assert.rejects(saveLauncherDevice('UNKNOWN', directory), /Unsupported/);
  assert.equal(await selected(directory), 'IOSIPAD');
  await writeFile(path.join(directory, 'LinePort/launcher-device.json'), '{"device":"UNKNOWN"}');
  await assert.rejects(selected(directory), /Invalid saved device choice/);
});
