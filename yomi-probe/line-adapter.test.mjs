import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLineRelayAdapter, createMultiRelay } from './multi-relay.mjs';
import { lineDirectory } from './line-directory.mjs';
import { normalizeConfig } from './route-config.mjs';

const endpoint = id => ({ platform: 'line', id, name: id });
function fixture() {
  const calls = [], messages = [];
  const service = Object.assign(new EventEmitter(), {
    profile: { mid: 'usynthetic' }, loginRequired: false, resumeSession: async () => true,
    e2eeManager: { getSelfKeyByMid: () => ({}), encryptE2EEMessage: async (...args) => calls.push(['encrypt', ...args]) },
    client: { getAllChatMids: async () => ({ memberChats: ['csource', 'cdestination'] }), getChats: async ids => ids.map(chatMid => ({ chatMid })), getAllContactIds: async () => ['ufriend'], getContacts: async ids => ids.map(mid => ({ mid })) },
    getRecentMessages: async () => messages,
    sendMessage: async (...args) => { calls.push(['send', ...args]); return { id: '999' }; },
  });
  return { service, calls, messages };
}

test('group-only relay starts despite an unavailable contacts API', async () => {
  const { service, calls } = fixture(); service.client.getAllContactIds = async () => { assert.fail('Unrelated contacts API called'); };
  const adapter = await createLineRelayAdapter(service, [endpoint('csource'), endpoint('cdestination')]);
  await adapter.prepare('cdestination'); await adapter.send('cdestination', 'synthetic');
  assert.deepEqual(calls.map(call => call[0]), ['encrypt', 'send']);
});

test('person-only relay does not depend on the groups API', async () => {
  const { service } = fixture(); service.client.getAllChatMids = async () => { assert.fail('Unrelated groups API called'); };
  const adapter = await createLineRelayAdapter(service, [endpoint('ufriend')]);
  await adapter.prepare('ufriend'); assert.deepEqual(await adapter.recent('ufriend'), []);
});

test('mixed routes still require contacts when a person endpoint is configured', async () => {
  const { service } = fixture(); service.client.getAllContactIds = async () => { throw new Error('contacts unavailable'); };
  await assert.rejects(createLineRelayAdapter(service, [endpoint('csource'), endpoint('ufriend')]), /contacts unavailable/);
});

test('revoked authentication or non-member endpoints cannot read, prepare or send', async () => {
  const { service, calls } = fixture(), adapter = await createLineRelayAdapter(service, [endpoint('csource')]);
  for (const id of ['cunknown', 'csource']) {
    service.loginRequired = id === 'csource';
    await assert.rejects(adapter.prepare(id)); await assert.rejects(adapter.recent(id)); await assert.rejects(adapter.read(id, 0, new Set()));
    assert.throws(() => adapter.send(id, 'synthetic'));
  }
  assert.deepEqual(calls, []);
});

test('large group directories are batched, deduplicated and restricted to joined groups', async () => {
  const { service } = fixture(), ids = Array.from({ length: 205 }, (_, index) => `c${index}`), batches = [];
  service.client.getAllChatMids = async () => ({ memberChats: [...ids, ids[0]], invitedChats: ['cinvited'] });
  service.client.getChats = async batch => { batches.push(batch); return [...batch.map(chatMid => ({ chatMid })), { chatMid: 'cinvited' }]; };
  const rows = await lineDirectory(service, { contacts: false });
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
  assert.deepEqual(rows.map(row => row.id), ids);
});

test('LINE adapter completes relay initialization, sending and restart deduplication', async () => {
  const { service, calls, messages } = fixture();
  const source = endpoint('csource'), destination = endpoint('cdestination');
  const adapter = await createLineRelayAdapter(service, [source, destination]);
  const config = normalizeConfig({ version: 1, rules: [{ id: 'one', name: 'one', enabled: true, sources: [source], destinations: [destination] }] });
  const options = { config, adapters: { line: adapter }, directory: await mkdtemp(path.join(os.tmpdir(), 'lineport-adapter-')), now: () => 1000, pause: async () => {} };
  const relay = await createMultiRelay(options); assert.equal(relay.state.phase, 'running');
  messages.push({ id: '1', text: 'synthetic', createdTime: 2000, from: 'ufriend', to: 'csource', contentType: 0 });
  await relay.tick(); assert.equal(relay.state.forwarded, 1);
  const restarted = await createMultiRelay(options); await restarted.tick();
  assert.equal(calls.filter(call => call[0] === 'send').length, 1);
});

test('bot destinations automatically use compatible text while other routes retain E2EE and restart deduplication', async () => {
  const { service, calls, messages } = fixture();
  service.client.getAllChatMids = async () => ({ memberChats: ['csource', 'cdestination', 'cgood'] });
  service.client.getChats = async ids => ids.map(chatMid => ({ chatMid, extra: { 1: { 4: { usynthetic: 1, ubot: 1 } } } }));
  service.client.negotiateE2EEPublicKey = async mid => ({ 3: mid === 'ubot' ? -1 : 2 });
  service.client.getContacts = async ids => ids.map(mid => ({ mid, isOfficial: mid === 'ubot' }));
  service.client.sendMessage = async payload => { calls.push(['transport', payload]); return { id: '998' }; };
  service.e2eeManager.encryptE2EEMessage = async id => {
    if (id === 'cdestination') throw new Error(`No existing LINE group E2EE key for ${id}; synthetic`);
    calls.push(['encrypt', id]);
  };
  const source = endpoint('csource'), destinations = [endpoint('cdestination'), endpoint('cgood')];
  const config = normalizeConfig({ version: 1, rules: [{ id: 'one', enabled: true, sources: [source], destinations }] });
  const options = { config, directory: await mkdtemp(path.join(os.tmpdir(), 'lineport-bot-')), now: () => 1000, pause: async () => {} };
  const start = async () => createMultiRelay({ ...options, adapters: { line: await createLineRelayAdapter(service, [source, ...destinations]) } });
  const relay = await start();
  assert.equal(relay.state.phase, 'running');
  assert.deepEqual(relay.state.routes.map(route => route.lineProtection), ['transport', 'e2ee']);
  messages.push({ id: '1', text: 'Synthetic source text', createdTime: 2000, from: 'ufriend', to: 'csource', contentType: 0 });
  await relay.tick();
  assert.equal(relay.state.forwarded, 2);
  assert.deepEqual(calls.filter(call => call[0] === 'transport'), [['transport', { to: 'cdestination', text: 'Synthetic source text', contentType: 0 }]]);
  assert.deepEqual(calls.filter(call => call[0] === 'send').map(call => call[1]), ['cgood']);
  const restarted = await start(); await restarted.tick();
  assert.equal(calls.filter(call => ['send', 'transport'].includes(call[0])).length, 2);
  // Caller-supplied options cannot downgrade a prepared E2EE destination.
  const adapter = await createLineRelayAdapter(service, [source, ...destinations]);
  await adapter.prepare('cgood');
  await adapter.send('cgood', 'Synthetic', { transportOnly: true });
  assert.equal(calls.at(-1)[0], 'send');
  assert.throws(() => adapter.send('csource', 'Synthetic'), /尚未完成準備/);
  await adapter.prepare('cdestination');
  assert.throws(() => adapter.send('cdestination', { kind: 'photo' }), /僅支援文字/);
});

test('bot compatibility blocks media routes before downloading or posting attachments', async () => {
  const config = normalizeConfig({ version: 1, rules: [{ id: 'media', enabled: true, media: true,
    sources: [{ platform: 'telegram', id: '-1' }], destinations: [endpoint('cdestination')] }] });
  const relay = await createMultiRelay({ config, directory: await mkdtemp(path.join(os.tmpdir(), 'lineport-bot-media-')),
    adapters: { telegram: { identity: 'synthetic-telegram', recent: () => assert.fail('Do not read blocked media source') },
      line: { identity: 'synthetic-line', prepare: async () => 'transport', send: () => assert.fail('Do not send media') } } });
  assert.equal(relay.state.phase, 'failed');
  assert.equal(relay.state.routes[0].stage, 'destination_prepare');
  assert.match(relay.state.routes[0].warning, /僅支援相容文字/);
});
