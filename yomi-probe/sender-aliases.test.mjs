import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, senderMatches } from './rule-options.mjs';

const sources = [{ platform: 'line', id: 'cgroup' }];
test('aliases survive normalization and never select a sender by name', () => {
  const rule = normalizeOptions({ senderAliases: { 'line:cgroup': { uone: ' Local name ' } }, senderAllowlist: { 'line:cgroup': ['uone'] } }, sources, []);
  assert.equal(rule.senderAliases['line:cgroup'].uone, 'Local name');
  assert.equal(senderMatches(rule, 'line:cgroup', { from: 'uone', senderName: 'Changed' }), true);
  assert.equal(senderMatches(rule, 'line:cgroup', { from: 'utwo', senderName: 'Local name' }), false);
  assert.deepEqual(normalizeOptions(rule, sources, []), rule);
});
test('invalid aliases are rejected and old rules retain their shape', () => {
  for (const senderAliases of [[], { 'line:other': { uone: 'Name' } }, { 'line:cgroup': { invalid: 'Name' } }, { 'line:cgroup': { uone: '\nName' } }, { 'line:cgroup': { uone: 'x'.repeat(101) } }]) {
    assert.throws(() => normalizeOptions({ senderAliases }, sources, []));
  }
  assert.equal('senderAliases' in normalizeOptions({}, sources, []), false);
});

import { settingsBackup, validateBackup, safeDiagnostics } from './user-tools.mjs';
test('settings backup preserves aliases while diagnostics excludes them', () => {
  const config = { version: 1, rules: [{ id: 'test', name: 'Example', enabled: true, sources, destinations: [{ platform: 'line', id: 'cdest' }], senderAliases: { 'line:cgroup': { uone: 'Private alias' } }, senderAllowlist: { 'line:cgroup': ['uone'] } }] };
  const restored = validateBackup(JSON.parse(JSON.stringify(settingsBackup(config))));
  assert.equal(restored.rules[0].senderAliases['line:cgroup'].uone, 'Private alias');
  const diagnostic = JSON.stringify(safeDiagnostics({ phase: 'stopped', routes: [{ ...restored.rules[0], phase: 'stopped' }] }, true));
  assert.equal(diagnostic.includes('Private alias'), false);
  assert.equal(diagnostic.includes('uone'), false);
});
