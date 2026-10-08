import test from 'node:test';
import assert from 'node:assert/strict';
import { guardProtocol } from './protocol-guard.mjs';

test('resolved timeouts and HTTP errors cannot masquerade as empty recent messages', async () => {
  class FakeClient { async sendCompact() { return this.reply; } }
  guardProtocol(FakeClient);
  guardProtocol(FakeClient);
  const client = new FakeClient();
  for (const reply of [{ error: 'timeout' }, { error: 'empty_response' }, { statusCode: 429, fields: { 0: [] } }, { fields: {} }, null]) {
    client.reply = reply;
    await assert.rejects(() => client.sendCompact('/S4', 'getRecentMessagesV2', []));
  }
  client.reply = { statusCode: 200, fields: { 0: [] } };
  assert.equal(await client.sendCompact('/S4', 'getRecentMessagesV2', []), client.reply);
});
