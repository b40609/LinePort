import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('entry follows setup progress without requiring LINE for other platforms', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(html.split('\n').find(line => line.startsWith('function initialPanel(')), context);
  const choose = (connected, phase, rules = [], available = []) => context.initialPanel({ connected }, { phase }, rules, available);
  const rule = platform => ({ enabled: true, sources: [{ platform }], destinations: [{ platform }] });
  assert.equal(choose(false, 'stopped'), 'Accounts');
  assert.equal(choose(true, 'stopped'), 'Accounts', 'load chatrooms before creating rules');
  assert.equal(choose(true, 'stopped', [], [{}]), 'Rules');
  assert.equal(choose(false, 'stopped', [rule('line')], [{}]), 'Accounts', 'expired LINE session needs relinking');
  assert.equal(choose(false, 'stopped', [rule('telegram')], [{}]), 'Overview');
  assert.equal(choose(false, 'stopped', [rule('discord')], [{}]), 'Overview');
  assert.equal(choose(true, 'stopped', [rule('line')], [{}]), 'Overview');
  assert.equal(choose(true, 'stopped', [{ ...rule('line'), enabled: false }], [{}]), 'Rules');
  assert.equal(choose(false, 'running', [rule('line')]), 'Overview', 'active relay status takes priority over page session');
});

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

test('failed routes show the operation stage and recovery guidance without inventing unknown stages', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const rendered = [];
  const context = vm.createContext({ Date, $: () => ({ replaceChildren() {}, append(node) { rendered.push(node.textContent); } }), document: { createElement: () => ({}) } });
  vm.runInContext(html.split('\n').find(line => line.startsWith('function renderRouteStatuses(')), context);
  const route = { name: 'Test', source: { name: 'Source' }, destination: { name: 'Destination' }, phase: 'failed', stage: 'destination_e2ee', forwarded: 0, pending: 0, uncertain: 0, errors: 1, skipped: 0, warning: '請確認網路並在目的群組發一則新文字' };
  context.relay = { routes: [route, { ...route, stage: 'unknown' }] };
  vm.runInContext('renderRouteStatuses(relay)', context);
  assert.match(rendered[0], /失敗階段：目的聊天室加密準備（destination_e2ee）/);
  assert.match(rendered[0], /請確認網路並在目的群組發一則新文字/);
  assert.ok(!rendered[1].includes('失敗階段'));
});

test('running with skipped messages shows a warning and clears it after stopping', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const nodes = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    const classes = new Set();
    nodes.set(id, { value: '', textContent: '', removeAttribute(name) { delete this[name]; }, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } } });
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

test('rule deletion requires confirmation and resets only the deleted editor after saving', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  let approved = false, saved, resets = 0;
  const notice = {};
  const context = vm.createContext({ confirm: () => approved, $: () => notice, resetEditor: () => resets++, saveConfig: async rules => { saved = rules; } });
  vm.runInContext(html.split('\n').find(line => line.startsWith('async function deleteRule(')), context);
  context.config = { rules: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  context.editingId = 'a';
  await context.deleteRule('a');
  assert.equal(saved, undefined);
  assert.equal(resets, 0);
  approved = true;
  await context.deleteRule('a');
  assert.deepEqual(Array.from(saved, rule => rule.id), ['b']);
  assert.equal(resets, 1);
  assert.equal(notice.textContent, '規則已刪除。');
  context.saveConfig = async () => { throw new Error('save failed'); };
  await assert.rejects(context.deleteRule('a'), /save failed/);
  assert.equal(resets, 1, 'failed saves preserve editor state');
});

test('automatic choices load once, defer while busy and respect source mode and relay lock', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  let directories = 0, senders = 0;
  const context = vm.createContext({
    lastState: { connected: true }, pending: false, switching: false, settingsLoaded: true,
    directoryAttempted: false, sendersAttempted: '', relayState: { phase: 'stopped' },
    senderSource: 'line:a', senderModes: { 'line:a': 'all' },
    selected: () => [{ platform: 'line', id: 'a' }], key: source => source.platform + ':' + source.id,
    $: id => ({ onclick: async () => { if(id === 'groups'){directories++;context.directoryAttempted=true;}else{senders++;context.sendersAttempted=context.senderSource;} } }),
  });
  vm.runInContext(html.split('\n').find(line => line.startsWith('async function autoLoadChoices(')), context);
  await context.autoLoadChoices(); await context.autoLoadChoices();
  assert.equal(directories, 1); assert.equal(senders, 0);
  context.senderModes['line:a'] = 'specific';context.pending = true;
  await context.autoLoadChoices();assert.equal(senders, 0);
  context.pending = false;context.relayState.phase = 'running';
  await context.autoLoadChoices();assert.equal(senders, 0);
  context.relayState.phase = 'stopped';
  await context.autoLoadChoices();await context.autoLoadChoices();assert.equal(senders, 1);
  context.lastState.connected = false;await context.autoLoadChoices();
  assert.equal(context.directoryAttempted, false);
  context.lastState.connected = true;await context.autoLoadChoices();assert.equal(directories, 2);
});

test('start button explains missing rules, paused rules and expired LINE login', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const nodes = new Map();
  const context = vm.createContext({
    $: id => {if(!nodes.has(id))nodes.set(id, {value:'', textContent:''});return nodes.get(id);},
    document: {}, pending:false,switching:false,lastState:{connected:false},relayState:{phase:'stopped'},
    config:{rules:[]},endpoints:[],collected:new Map(),restoreBackup:null,reading:false,workspaceControls(){},
  });
  vm.runInContext(html.split('\n').find(line => line.startsWith('function controls(')), context);
  context.controls();assert.match(nodes.get('startHelp').textContent, /尚未建立規則/);assert.equal(nodes.get('start').disabled, true);
  context.config.rules = [{enabled:false}];context.controls();assert.match(nodes.get('startHelp').textContent, /全部規則已暫停/);
  context.config.rules = [{enabled:true,sources:[{platform:'line'}],destinations:[]}];context.controls();
  assert.match(nodes.get('startHelp').textContent, /重新登入 LINE/);
  context.lastState.connected=true;context.controls();assert.equal(nodes.get('start').disabled,false);
  assert.match(nodes.get('startHelp').textContent, /準備完成/);
});

test('replacing an unsaved draft requires explicit confirmation', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  let prompts=0;
  const context=vm.createContext({editorDirty:false,confirm:()=>{prompts++;return false;}});
  vm.runInContext(html.split('\n').find(line=>line.startsWith('function canDiscardEditor(')),context);
  assert.equal(context.canDiscardEditor(),true);assert.equal(prompts,0);
  context.editorDirty=true;assert.equal(context.canDiscardEditor(),false);assert.equal(prompts,1);
  context.confirm=()=>true;assert.equal(context.canDiscardEditor(),true);
});
