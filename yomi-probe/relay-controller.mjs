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
        if (state.version === 3) {
          const endpoint = value => ({ platform: ['telegram', 'discord'].includes(value?.platform) ? value.platform : 'line', id: String(value?.id || '').slice(0, 100), name: String(value?.name || '').slice(0, 100) });
          const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
          safe.routes = Array.isArray(state.routes) ? state.routes.slice(0, 100).map(route => ({
            key: String(route.key || '').slice(0, 64), ruleId: String(route.ruleId || '').slice(0, 64), name: String(route.name || '').slice(0, 100),
            source: endpoint(route.source), destination: endpoint(route.destination), phase: String(route.phase || '').slice(0, 30),
            forwarded: count(route.forwarded), pending: count(route.pending), uncertain: count(route.uncertain), errors: count(route.errors), skipped: count(route.skipped),
            lastSend: typeof route.lastSend === 'string' ? route.lastSend.slice(0, 40) : null, warning: String(route.warning || '').slice(0, 300),
            retryAt: count(route.retryAt),
          })) : [];
          safe.sources = Array.isArray(state.sources) ? state.sources.slice(0, 100).map(source => ({ ...endpoint(source), polls: count(source.polls), received: count(source.received), decryptFailed: count(source.decryptFailed), lastPoll: typeof source.lastPoll === 'string' ? source.lastPoll.slice(0, 40) : null, warning: String(source.warning || '').slice(0, 300) })) : [];
          safe.warning = ['degraded', 'failed'].includes(state.phase) ? '部分路線受阻，請查看各路線與來源狀態' : '';
        }
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
    async startRules(revision) {
      if (!/^[a-f0-9]{64}$/.test(revision)) throw new RelayError('規則版本不正確');
      try { await script('start-relay.ps1', { LINEPORT_CONFIG_REVISION: revision }); }
      catch { throw new RelayError('多規則轉送啟動失敗；請查看各路線狀態、帳號連結及本機服務'); }
    },
    stop() { return script('stop-relay.ps1'); },
  };
  return controller;
}
