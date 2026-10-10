import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRuntimeService } from './node_modules/@rikaidev/yomi/dist/line/core/chat-runtime-service.js';
import { sendRelayText } from './relay-send.mjs';

test('installed LINE runtime reads, decrypts, paginates and forwards without invoking read receipts', async () => {
  const calls = [];
  const message = { id: 'synthetic-source-message', from: 'usynthetic', chunks: ['synthetic'] };
  const service = {
    client: {
      async getRecentMessages(id, count) { calls.push(['recent', id, count]); return [message]; },
      async getPreviousMessagesV2WithRequest(request) { calls.push(['previous', request.messageBoxId]); return [message]; },
      async sendMessage(payload) { calls.push(['send', payload.to]); return { id: 'synthetic-destination-message' }; },
      sendChatChecked() { assert.fail('A relay operation must not send a read receipt'); },
    },
    e2eeManager: {
      async tryDecrypt() { return { decrypted: true, text: '合成測試通知' }; },
      async encryptE2EEMessage() { return { contentType: 0, contentMetadata: {}, chunks: ['synthetic'] }; },
    },
  };
  Object.assign(service, createChatRuntimeService(service));
  service.markChatRead = () => assert.fail('A relay operation must not mark a chat read');
  assert.equal((await service.getRecentMessages('csynthetic-source', 50))[0].text, '合成測試通知');
  assert.equal((await service.getPreviousMessages('csynthetic-source', 50, { messageId: 'synthetic-cursor' }))[0].text, '合成測試通知');
  assert.equal((await sendRelayText(service, 'csynthetic-destination', '合成測試通知')).id, 'synthetic-destination-message');
  assert.deepEqual(calls, [['recent', 'csynthetic-source', 50], ['previous', 'csynthetic-source'], ['send', 'csynthetic-destination']]);
});
