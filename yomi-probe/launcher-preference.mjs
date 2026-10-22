import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { lineDevice } from './line-device.mjs';

// This preference contains only the selected protocol identity, never credentials.
export async function saveLauncherDevice(device, localAppData = process.env.LOCALAPPDATA) {
  lineDevice(device);
  if (!localAppData) throw new Error('LOCALAPPDATA is required');
  const directory = path.join(localAppData, 'LinePort');
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, 'launcher-device.json');
  const temporary = destination + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify({ device }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
}
