import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, matchingText, createSettingsStore, configRevision } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { readLineSince, lineDirectory } from './line-directory.mjs';

const endpoint = (id, platform = 'line') => ({ platform, id, name: id });
const rule = (id = 'one', sources = [endpoint('csource')], destinations = [endpoint('cdestination')]) => ({ id, name: id, enabled: true, sources, destinations });
const config = (...rules) => normalizeConfig({ version: 1, rules });
const fixture = async () => mkdtemp(path.join(os.tmpdir(), 'lineport-routing-'));
const message = (id, text = 'hello', time = 1100) => ({ id, text, createdTime: time, deliveredTime: time });
function adapter({ recent = [], messages = [], send } = {}) {
  const calls = [], reads = [];
  return { identity: 'synthetic-account', calls, reads, prepare: async () => {}, recent: async () => recent,
    read: async id => { reads.push(id); return messages; },
    send: send || (async (id, text) => { calls.push([id, text]); return { id: `out-${calls.length}-${id}` }; }) };
}

test('configuration rejects overlapping edges, cycles, invalid endpoints and excessive fan-out', () => {
  assert.throws(() => config(rule(), rule('two')), /重複/);
  assert.throws(() => config(rule(), rule('reverse', [endpoint('cdestination')], [endpoint('csource')])), /循環/);
  assert.throws(() => config(rule('self', [endpoint('csource')], [endpoint('csource')])), /相同/);
  assert.throws(() => config(rule('url', [endpoint('https://evil', 'telegram')])), /ID/);
  assert.throws(() => config(rule('invalid', [endpoint('9007199254740992', 'telegram')])), /範圍/);
  assert.throws(() => config(...Array.from({ length: 11 }, (_, i) => rule('r'+i, [endpoint('cs'+i)], Array.from({ length: 10 }, (_, j) => endpoint('cd'+j))))), /100/);
  assert.equal(config(rule('same-name', [{ ...endpoint('ca'), name: '💩💩💩' }], [{ ...endpoint('cb'), name: '💩💩💩' }])).rules.length, 1);
});

test('keyword filters use literal matching, exclude wins, and protected text never forwards', () => {
  const value = config({ ...rule(), include: ['ALERT', '.*'], exclude: ['ignore'], prefix: '[來源] ' }).rules[0];
  assert.equal(matchingText(value, message('one', 'Alert: ready')), '[來源] Alert: ready');
  assert.equal(matchingText(value, message('one', 'alert ignore')), null);
  assert.equal(matchingText(value, message('one', 'ordinary')), null);
  assert.equal(matchingText(value, { ...message('one', 'alert'), protected: true }), null);
});

test('saved rules round-trip atomically and the revision binds the full configuration', async () => {
  const store = createSettingsStore(await fixture());
  assert.deepEqual(await store.load(), { version: 1, rules: [] });
  const value = config(rule());
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  assert.equal(configRevision(await store.load()), configRevision(value));
  assert.notEqual(configRevision(config({ ...rule(), prefix: 'new' })), configRevision(value));
});

test('fan-out reads a source once, filters history, and restart never duplicates a successful destination', async () => {
  const directory = await fixture(), value = config(rule('one', [endpoint('cs')], [endpoint('cd1'), endpoint('ud2')]));
  const line = adapter({ recent: [message('old', 'old', 900)], messages: [message('old', 'old', 900), message('new')] });
  const relay = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 1000, pause: async () => {} });
  await relay.tick();
  assert.equal(line.reads.length, 1);
  assert.deepEqual([...line.calls].sort((a, b) => a[0].localeCompare(b[0])), [['cd1', 'hello'], ['ud2', 'hello']]);
  assert.equal(relay.state.forwarded, 2);
  const restarted = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 2000, pause: async () => {} });
  await restarted.tick();
  assert.equal(line.calls.length, 2);
});

test('one uncertain destination pauses durably while other destinations and sources keep delivering', async () => {
  const directory = await fixture(), deliveries = [];
  const line = adapter({ messages: [message('a'), message('b', 'second', 1200)], send: async (id, text) => {
    if (id === 'cbad') throw new Error('synthetic network timeout with private details');
    deliveries.push([id, text]); return { id: 'out-'+deliveries.length };
  } });
  const value = config(rule('r', [endpoint('cs')], [endpoint('cbad'), endpoint('cgood')]));
  const relay = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 1000, pause: async () => {} });
  await relay.tick();
  assert.equal(relay.state.phase, 'degraded');
  assert.equal(relay.state.routes[0].phase, 'blocked');
  assert.equal(relay.state.uncertain, 1);
  assert.equal(deliveries.length, 2);
  assert.ok(!JSON.stringify(relay.state).includes('private details'));
  const restarted = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 2000, pause: async () => {} });
  assert.equal(restarted.state.routes[0].phase, 'blocked');
  await restarted.tick();
  assert.equal(deliveries.length, 2);
});

test('an unfinished sending row after a crash blocks that route without resending', async () => {
  const directory = await fixture(), line = adapter(), value = config(rule());
  const first = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 1000 });
  const { readdir } = await import('node:fs/promises');
  const file = (await readdir(directory)).find(name => name.startsWith('lineport-route-'));
  await appendFile(path.join(directory, file), JSON.stringify({ id: 'uncertain', outcome: 'sending' })+'\n');
  const second = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 2000 });
  assert.equal(first.state.phase, 'running');
  assert.equal(second.state.phase, 'failed');
  assert.equal(second.state.routes[0].phase, 'blocked');
  await second.tick();
  assert.equal(line.calls.length, 0);
});

test('bridge-generated messages do not cascade into a downstream route after restart', async () => {
  const directory = await fixture();
  let stage = 0;
  const line = adapter({ send: async () => ({ id: 'bridge-output' }) });
  line.read = async id => id === 'ca' ? [message('input')] : stage ? [message('bridge-output')] : [];
  const value = config(rule('ab', [endpoint('ca')], [endpoint('cb')]), rule('bc', [endpoint('cb')], [endpoint('cc')]));
  const first = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 1000 });
  await first.tick(); stage = 1;
  const second = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 2000 });
  await second.tick();
  assert.equal(second.state.forwarded, 0);
});

test('independent Telegram route runs even when the LINE platform cannot initialize', async () => {
  const directory = await fixture(), telegram = adapter({ messages: [message('1:1')] });
  const value = config(rule(), rule('tg', [endpoint('1', 'telegram')], [endpoint('-2', 'telegram')]));
  const relay = await createMultiRelay({ config: value, adapters: { telegram }, directory, now: () => 1000 });
  await relay.tick();
  assert.equal(relay.state.phase, 'degraded');
  assert.equal(telegram.calls.length, 1);
});

test('LINE pagination reaches a shared checkpoint, and stops safely on missing or stuck cursors', async () => {
  const page = Array.from({ length: 50 }, (_, index) => message('new'+index, 'text', 2000+index));
  const cursors = [];
  const service = { getRecentMessages: async () => page, getPreviousMessages: async (id, count, cursor) => { cursors.push(cursor); return [message('checkpoint', 'old', 1100)]; } };
  const result = await readLineSince(service, 'c1', 1000, new Set(['checkpoint']));
  assert.equal(result.length, 51);
  assert.deepEqual(cursors, [{ messageId: 'new0', deliveredTime: 2000 }]);
  await assert.rejects(readLineSince({ ...service, getPreviousMessages: async () => page }, 'c1', 1000, new Set()), /advance/);
  await assert.rejects(readLineSince(service, 'c1', 1000, new Set(), { maxPages: 1 }), /exceeded/);
});

test('LINE directory accepts only current member groups and friends, excluding official accounts', async () => {
  const service = { client: { getAllChatMids: async () => ({ memberChats: ['c1'], invitedChats: ['c2'] }), getChats: async () => [{ chatMid: 'c1', chatName: '💩💩💩' }, { chatMid: 'c2' }],
    getAllContactIds: async () => ['u1', 'u2'], getContacts: async () => [{ mid: 'u1', displayName: '朋友' }, { mid: 'u2', isOfficial: true }, { mid: 'u3' }] } };
  assert.deepEqual((await lineDirectory(service)).map(row => row.id), ['c1', 'u1']);
});

test('a failed source backs off independently and healthy sources continue sending', async () => {
  let time = 1000;
  const line = adapter(), attempts = [];
  line.read = async id => { attempts.push(id); if (id === 'cbad') throw new Error('private upstream details'); return [message('healthy-'+time, 'healthy', time+1)]; };
  const relay = await createMultiRelay({ config: config(rule('r', [endpoint('cbad'), endpoint('cgood')], [endpoint('cdest')])), adapters: { line }, directory: await fixture(), now: () => time, pause: async () => {} });
  await relay.tick();
  assert.equal(relay.state.phase, 'degraded');
  assert.equal(line.calls.length, 1);
  time = 2000; await relay.tick();
  assert.equal(attempts.filter(id => id === 'cbad').length, 1);
  assert.equal(line.calls.length, 2);
  time = 4000; await relay.tick();
  assert.equal(attempts.filter(id => id === 'cbad').length, 2);
  assert.ok(!JSON.stringify(relay.state).includes('private upstream'));
});

test('sources sharing one destination send serially with spacing and a missing ack blocks only its edge', async () => {
  const events = [];
  const line = adapter({ messages: [message('input')], send: async (id, text) => { events.push('send'); return { id: 'out-'+events.length }; } });
  const relay = await createMultiRelay({ config: config(rule('r', [endpoint('ca'), endpoint('cb')], [endpoint('cd')])), adapters: { line }, directory: await fixture(), now: () => 1000, pause: async ms => events.push(ms) });
  await relay.tick();
  assert.deepEqual(events, ['send', 1100, 'send']);
  const uncertain = adapter({ messages: [message('input')], send: async () => ({}) });
  const blocked = await createMultiRelay({ config: config(rule()), adapters: { line: uncertain }, directory: await fixture(), now: () => 1000 });
  await blocked.tick();
  assert.equal(blocked.state.routes[0].phase, 'blocked');
  assert.equal(blocked.state.forwarded, 0);
  const mixedEvents = [];
  let attempts = 0;
  const mixed = adapter({ messages: [message('input')], send: async () => {
    mixedEvents.push('send');
    return ++attempts === 1 ? {} : { id: 'confirmed' };
  } });
  const continuing = await createMultiRelay({ config: config(rule('r', [endpoint('ca'), endpoint('cb')], [endpoint('cd')])), adapters: { line: mixed }, directory: await fixture(), now: () => 1000, pause: async ms => mixedEvents.push(ms) });
  await continuing.tick();
  assert.deepEqual(mixedEvents, ['send', 1100, 'send']);
  assert.equal(continuing.state.routes[0].phase, 'blocked');
  assert.equal(continuing.state.routes[1].phase, 'running');
  assert.equal(continuing.state.forwarded, 1);
});

test('a post-send journal failure preserves the sending checkpoint and cannot silently resend', async () => {
  const directory = await fixture(), line = adapter({ messages: [message('input'), message('second', 'later', 1200)] }), value = config(rule());
  const relay = await createMultiRelay({ config: value, adapters: { line }, directory, now: () => 1000, pause: async () => {} });
  // A synthetic directory makes the output-journal append fail after acknowledgement.
  await mkdir(path.join(directory, 'lineport-output.jsonl'));
  await relay.tick();
  assert.equal(line.calls.length, 1);
  assert.equal(relay.state.routes[0].phase, 'failed');
  await relay.tick();
  assert.equal(line.calls.length, 1);
  await assert.rejects(createMultiRelay({ config: value, adapters: { line }, directory, now: () => 2000 }));
});

test('source diagnostics show invalid timestamps instead of reporting a healthy idle relay', async () => {
  const line = adapter({ messages: [message('invalid', 'text', 0)] });
  const relay = await createMultiRelay({ config: config(rule()), adapters: { line }, directory: await fixture(), now: () => 1000 });
  await relay.tick();
  assert.equal(relay.state.phase, 'degraded');
  assert.match(relay.state.sources[0].warning, /時間/);
  assert.equal(line.calls.length, 0);
});

test('Telegram source counters reflect network polls instead of cached inbox reads', async () => {
  const telegram = adapter();
  telegram.health = () => ({ polls: 3, lastPoll: '2026-10-08T00:00:00.000Z' });
  const relay = await createMultiRelay({ config: config(rule('tg', [endpoint('1', 'telegram')], [endpoint('2', 'telegram')])), adapters: { telegram }, directory: await fixture(), now: () => 1000 });
  await relay.tick(); await relay.tick();
  assert.equal(relay.state.polls, 3);
  assert.equal(relay.state.sources[0].polls, 3);
});

test('saving a Telegram token overrides a fallback environment token without exposing either value', async () => {
  const store = createSettingsStore(await fixture());
  const previous = process.env.LINEPORT_TELEGRAM_TOKEN;
  process.env.LINEPORT_TELEGRAM_TOKEN = 'synthetic-fallback';
  try {
    assert.equal(await store.telegramToken(), 'synthetic-fallback');
    await store.saveTelegram('synthetic-saved');
    assert.equal(await store.telegramToken(), 'synthetic-saved');
  } finally {
    if (previous === undefined) delete process.env.LINEPORT_TELEGRAM_TOKEN;
    else process.env.LINEPORT_TELEGRAM_TOKEN = previous;
  }
});
