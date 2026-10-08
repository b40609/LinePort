import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  return {
    async status() {
      try {
        const response = await request('http://127.0.0.1:18766/status', { signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (!response.ok) return { phase: 'unavailable' };
        const state = await response.json();
        if (state.app !== 'line-relay-bridge') return { phase: 'legacy' };
        // Only expose known, non-credential status fields to the page.
        return Object.fromEntries(['phase', 'stage', 'source', 'destination', 'polls', 'forwarded', 'uncertain', 'errors', 'lastPoll', 'retrySeconds'].map(key => [key, state[key]]));
      } catch (error) {
        return { phase: error?.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'unavailable' };
      }
    },
    start(source, destination) {
      // Names travel as environment values, never as executable command text.
      return script('start-relay.ps1', { LINECALL_SOURCE: source, LINECALL_DESTINATION: destination });
    },
    stop() { return script('stop-relay.ps1'); },
  };
}
