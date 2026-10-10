import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, mkdir, rename, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewRules, settingsBackup, validateBackup, safeDiagnostics } from './user-tools.mjs';
import { createSettingsStore, normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { createDeliveryReviewStore } from './delivery-review.mjs';

const config = () => normalizeConfig({ version: 1, rules: [{ id: 'demo', name: 'Synthetic route', enabled: true,
  sources: [{ platform: 'line', id: 'csource', name: 'Synthetic source' }],
  destinations: [{ platform: 'telegram', id: '-1', name: 'Synthetic destination' }], include: ['work'], exclude: ['secret'], prefix: '[work] ' }] });
const fixture = () => mkdtemp(path.join(os.tmpdir(), 'lineport-user-tools-'));

test('preview matches actual literal filters, exclusion, prefix and protected content without sending', () => {
  const input = { config: config(), source: 'line:csource', text: 'WORK update' };
  const result = previewRules(input).results[0];
  assert.equal(result.text, '[work] WORK update');
  assert.equal(result.destinations[0].eligible, true);
  for (const override of [{ text: 'other' }, { text: 'work secret' }, { protected: true }, { text: '' }]) assert.equal(previewRules({ ...input, ...override }).results[0].text, null);
  input.config.rules[0].enabled = false;
  assert.equal(previewRules(input).results[0].destinations[0].eligible, false);
  assert.throws(() => previewRules({ ...input, text: 'a'.repeat(10001) }), /10,000/);
});
test('preview independently reports Telegram size limits and rejects invalid rule graphs', () => {
  const input = { config: config(), source: 'line:csource', text: 'work'+'a'.repeat(4093) };
  assert.equal(previewRules(input).results[0].destinations[0].eligible, false);
  input.config.rules[0].destinations.push({ platform: 'line', id: 'cdestination' });
  assert.equal(previewRules(input).results[0].destinations[1].eligible, true);
  input.config.rules[0].destinations.push(input.config.rules[0].sources[0]);
  assert.throws(() => previewRules(input), /相同/);
});
test('diagnostics allowlists counts and phases, excluding secrets, identity, text and errors', () => {
  const secret = 'SYNTHETIC_PRIVATE_DATA';
  const result = safeDiagnostics({ phase: 'running', token: secret, warning: secret, forwarded: 1, errors: -1,
    routes: [{ name: secret, source: { id: secret }, text: secret, phase: secret, pending: 3, warning: secret }] }, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.appVersion, '0.8.3');
  assert.equal(result.routes[0].pending, 3);
  assert.equal(result.routes[0].phase, 'unavailable');
  assert.equal(result.totals.errors, 0);
});
test('settings export strips unknown credentials and validates format and cycles', () => {
  const value = config(); value.token = 'SYNTHETIC_SECRET'; value.rules[0].token = 'SYNTHETIC_SECRET';
  const backup = settingsBackup(value);
  assert.equal(backup.appVersion, '0.8.3');
  assert.ok(!JSON.stringify(backup).includes('SYNTHETIC_SECRET'));
  assert.deepEqual(validateBackup(backup), config());
  assert.throws(() => validateBackup({ ...backup, version: 2 }), /格式/);
});
test('restore saves the original settings before replacing rules; invalid input does not write', async () => {
  const directory = await fixture(), store = createSettingsStore(directory);
  await store.save(config());
  const restored = await store.restore({ version: 1, rules: [] });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, restored.backup), 'utf8')), config());
  assert.equal((await store.load()).rules.length, 0);
  const before = await readdir(directory);
  await assert.rejects(store.restore({ version: 2, rules: [] }));
  assert.deepEqual(await readdir(directory), before);
});
test('a failed settings replacement retains the pre-restore backup', async () => {
  const directory = await fixture(), store = createSettingsStore(directory);
  await store.save(config());
  // Make replacement fail only after the backup has been written.
  const originalLoad = store.load;
  store.load = async () => { const value = await originalLoad(); await rename(path.join(directory, 'lineport-rules.json'), path.join(directory, 'original.json')); await mkdir(path.join(directory, 'lineport-rules.json')); return value; };
  await assert.rejects(store.restore({ version: 1, rules: [] }));
  const backup = (await readdir(directory)).find(name => name.startsWith('lineport-settings-before-restore-'));
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, backup), 'utf8')), config());
});

async function ambiguousFixture() {
  const directory = await fixture(), value = config(), calls = [];
  value.rules[0].include = []; value.rules[0].prefix = '';
  let fail = true;
  const adapters = {
    line: { identity: 'synthetic-line', prepare: async () => {}, recent: async () => [], read: async () => [{ id: 'a', text: 'first', createdTime: 1100 }, { id: 'b', text: 'second', createdTime: 1101 }] },
    telegram: { identity: 'synthetic-bot', prepare: async () => {}, send: async (id, text) => { calls.push(text); if (fail) throw new Error('synthetic timeout'); return { id: '-1:123' }; } },
  };
  const options = { config: value, directory, adapters, now: () => 1000, pause: async () => {} };
  await (await createMultiRelay(options)).tick();
  return { directory, options, calls, recover: () => { fail = false; }, store: createDeliveryReviewStore(directory) };
}
for (const decision of ['received', 'skip']) test(`single ${decision} resolution persists and only the remaining queue resumes`, async () => {
  const { directory, options, calls, recover, store } = await ambiguousFixture();
  const item = (await store.list()).items[0];
  assert.equal(item.text, 'first'); assert.equal(item.route.destination, 'Synthetic destination');
  const original = await readFile(path.join(directory, `lineport-route-${item.identity}.jsonl`), 'utf8');
  assert.equal((await createMultiRelay(options)).state.routes[0].phase, 'blocked');
  await store.resolve({ ...item, decision });
  await assert.rejects(store.resolve({ ...item, decision }), /變更/);
  assert.equal(await readFile(path.join(directory, `lineport-route-${item.identity}.jsonl`), 'utf8'), original);
  recover(); const restarted = await createMultiRelay(options); await restarted.tick();
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(restarted.state.routes[0].pending, 0);
  await (await createMultiRelay(options)).tick();
  assert.deepEqual(calls, ['first', 'second']);
});
test('review rejects bulk retry, traversal, stale revisions and truncated audit records', async () => {
  const { directory, options, store } = await ambiguousFixture();
  const item = (await store.list()).items[0];
  await assert.rejects(store.resolve({ ...item, decision: 'retry' }), /不提供重送/);
  await assert.rejects(store.resolve({ ...item, identity: '../secret', decision: 'skip' }), /識別碼/);
  await assert.rejects(store.resolve({ ...item, revision: '', decision: 'skip' }), /變更/);
  await appendFile(path.join(directory, `lineport-review-${item.identity}.jsonl`), '{');
  await assert.rejects(store.list(), /格式不完整/);
  const restarted = await createMultiRelay(options);
  assert.equal(restarted.state.routes[0].phase, 'failed');
});
