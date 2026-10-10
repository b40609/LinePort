import test from 'node:test';
import assert from 'node:assert/strict';
import { lineSourceSenders } from './source-senders.mjs';

function service(members) {
  const queries = [];
  return { queries, getRecentMessages: async () => { queries.push('recent'); return [{ from: 'urecent', text: 'SYNTHETIC_PRIVATE' }]; },
    client: { getChats: async (ids, withMembers) => { queries.push([ids, withMembers]); return [{ chatMid: 'cgroup', extra: members }]; },
      getContacts: async ids => ids.map(mid => ({ mid, displayName: '同名' })),
      markChatRead: () => { throw new Error('Read receipt forbidden'); }, sendChatChecked: () => { throw new Error('Read receipt forbidden'); } } };
}

test('LINE private contact name takes precedence while retaining original name', async () => {
  const fake = service(null);
  fake.client.getContacts = async ids => ids.map(mid => ({ mid, displayName: 'Original', displayNameOverridden: ' My alias ' }));
  assert.deepEqual((await lineSourceSenders(fake, 'uperson')).senders, [{ id: 'uperson', name: 'My alias', originalName: 'Original' }]);
  fake.client.getContacts = async ids => ids.map(mid => ({ mid, displayName: 'Original', displayNameOverridden: ' ' }));
  assert.deepEqual((await lineSourceSenders(fake, 'uperson')).senders, [{ id: 'uperson', name: 'Original' }]);
});

test('membership includes silent members and excludes invitations and invalid identities without reading messages', async () => {
  const members = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['umember' + i, 1]));
  const fake = service({ 1: { 4: { ...members, invalid: 1 }, 5: { uinvited: 1 } } });
  const result = await lineSourceSenders(fake, 'cgroup');
  assert.equal(result.listing, 'members'); assert.equal(result.senders.length, 17);
  assert.ok(result.senders.every(sender => sender.name === '同名'));
  assert.equal(new Set(result.senders.map(sender => sender.id)).size, 17);
  assert.deepEqual(fake.queries, [[['cgroup'], true]]);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE'));
});

test('missing membership falls back honestly, empty membership does not read history', async () => {
  const fake = service(null), result = await lineSourceSenders(fake, 'cgroup');
  assert.equal(result.listing, 'recent'); assert.match(result.explanation, /尚未發言/);
  assert.deepEqual(result.senders, [{ id: 'urecent', name: '同名' }]);
  const empty = service({ 1: { 4: {} } });
  assert.deepEqual((await lineSourceSenders(empty, 'cgroup')).senders, []);
  assert.equal(empty.queries.length, 1);
});

test('person source resolves directly and large lists batch contacts', async () => {
  const fake = service(null);
  assert.equal((await lineSourceSenders(fake, 'uperson')).listing, 'person');
  assert.deepEqual(fake.queries, []);
  const large = service({ 1: { 4: Object.fromEntries(Array.from({ length: 205 }, (_, i) => ['um' + i, 1])) } });
  const sizes = []; large.client.getContacts = async ids => { sizes.push(ids.length); return []; };
  assert.equal((await lineSourceSenders(large, 'cgroup')).senders.length, 205);
  assert.deepEqual(sizes, [100, 100, 5]);
});
