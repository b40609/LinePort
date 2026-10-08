import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relayWarning, relayFailure, RelayError } from './relay-health.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
export function createRelayController({ run = execute, request = fetch } = {}) {
  async function script(name, environment = {}) {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await run(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, name)], {
      cwd: root, windowsHide: true, timeout: 90000, maxBuffer: 65536,
      env: { ...process.env, ...environment },
    });
  }
  const controller = {
    async status() {
      try {
        const response = await request('http://127.0.0.1:18766/status', { signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (!response.ok) return { phase: 'unavailable' };
        const state = await response.json();
        if (state.app !== 'line-relay-bridge') return { phase: 'legacy' };
        // Only expose known, non-credential status fields to the page.
        const safe = Object.fromEntries(['phase', 'stage', 'source', 'destination', 'polls', 'forwarded', 'uncertain', 'errors', 'lastPoll', 'retrySeconds'].map(key => [key, state[key]]));
        if (state.lastRead) safe.lastRead = Object.fromEntries(['received', 'eligible', 'decryptFailed', 'invalidTime', 'history'].map(key => [key, Number.isSafeInteger(state.lastRead[key]) && state.lastRead[key] >= 0 ? state.lastRead[key] : 0]));
        safe.warning = relayWarning(safe);
        return safe;
      } catch (error) {
        return { phase: error?.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'unavailable' };
      }
    },
    async start(source, destination) {
      // Names travel as environment values, never as executable command text.
      try { await script('start-relay.ps1', { LINECALL_SOURCE: source, LINECALL_DESTINATION: destination }); }
      catch {
        const state = await controller.status();
        throw new RelayError(state.phase === 'failed' ? relayFailure(state.stage) : '轉送啟動器失敗；請確認 Node.js、PowerShell 與 18766 連接埠。');
      }
    },
    stop() { return script('stop-relay.ps1'); },
  };
  return controller;
}
