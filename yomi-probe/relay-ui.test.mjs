import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('running with skipped messages shows a warning and clears it after stopping', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const nodes = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    const classes = new Set();
    nodes.set(id, { value: '', textContent: '', classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } } });
  }
  let relay = { phase: 'running', warning: '來源有訊息無法解密', polls: 2, lastRead: { received: 5, eligible: 0, decryptFailed: 1, history: 0, invalidTime: 0 } };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id) }, setTimeout, clearTimeout,
    fetch: async url => ({ ok: true, json: async () => url.endsWith('relay/status') ? relay : { phase: 'connected', connected: true, error: '', pin: '' } }),
  });
  const source = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1].replace('controls();void heartbeat();', 'controls();');
  vm.runInContext(source, context);
  nodes.get('notice').textContent = '保留操作錯誤';
  await vm.runInContext('status()', context);
  assert.equal(nodes.get('relayLabel').textContent, '需要處理');
  assert.equal(nodes.get('relayBadge').classList.contains('live'), false);
  assert.match(nodes.get('readInfo').textContent, /解密失敗 1 則/);
  assert.match(nodes.get('relayNotice').textContent, /無法解密/);
  assert.equal(nodes.get('notice').textContent, '保留操作錯誤');
  relay = { phase: 'stopped' };
  await vm.runInContext('status()', context);
  assert.equal(nodes.get('relayLabel').textContent, '已停止');
  assert.equal(nodes.get('relayNotice').textContent, '');
});
