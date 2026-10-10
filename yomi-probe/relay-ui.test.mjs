import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('route status explains old scans and new messages rejected by conditions', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const rendered = [];
  const context = vm.createContext({ Date, $: () => ({ replaceChildren() {}, append(node) { rendered.push(node.textContent); } }), document: { createElement: () => ({}) } });
  vm.runInContext(html.split('\n').find(line => line.startsWith('function renderRouteStatuses(')), context);
  context.relay = { routes: [{ name: 'Test', source: { name: 'Source' }, destination: { name: 'Destination' }, phase: 'running', forwarded: 0, pending: 0, uncertain: 0, errors: 0, skipped: 1, lastRead: { received: 50, processed: 49, eligible: 1, matched: 0, filtered: 1 } }] };
  vm.runInContext('renderRouteStatuses(relay)', context);
  assert.match(rendered[0], /本輪掃描 50 則 · 已處理 49 · 新候選 1 · 符合條件 0 · 條件排除 1/);
  assert.match(rendered[0], /指定人員、關鍵字與排程/);
});

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
