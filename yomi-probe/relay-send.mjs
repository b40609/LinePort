import { destinationReply } from './reply-links.mjs';
// The public service already encrypts text; its argument must remain a string.
export function sendRelayText(service, destination, text, { replyTo } = {}) {
  if (replyTo !== undefined) {
    if (!destinationReply('line', destination, replyTo)) throw new Error('Invalid LINE reply');
    return service.sendMessage(destination, text, undefined, { relatedMessageId: replyTo, messageRelationType: 3, relatedMessageServiceCode: 1 });
  }
  return service.sendMessage(destination, text);
}

// Check destination key availability before entering running or marking IDs sent.
// Encryption prepares an in-memory payload only; no message is posted here.
export async function prepareRelayDestination(service, destination) {
  await service.e2eeManager.encryptE2EEMessage(destination, '', 0);
}
