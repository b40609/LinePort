import { destinationReply } from './reply-links.mjs';
// The public service already encrypts text; its argument must remain a string.
export function sendRelayText(service, destination, text, { replyTo, transportOnly = false } = {}) {
  let relation;
  if (replyTo !== undefined) {
    if (!destinationReply('line', destination, replyTo)) throw new Error('Invalid LINE reply');
    relation = { relatedMessageId: replyTo, messageRelationType: 3, relatedMessageServiceCode: 1 };
  }
  // The authenticated client retains LINE's transport encryption. Never retry a
  // failed send through another encryption mode: acceptance may be uncertain.
  if (transportOnly) return service.client.sendMessage({ to: destination, text, contentType: 0, ...relation });
  if (relation) return service.sendMessage(destination, text, undefined, relation);
  return service.sendMessage(destination, text);
}

// Read capabilities only, never messages or private keys. A missing group key
// alone is insufficient: confirm an official account explicitly reports no E2EE.
async function hasUnsupportedBot(service, destination, timeoutMs) {
  let expired = false, timer;
  const inspect = async () => {
    const chats = await service.client.getChats([destination], true);
    const chat = chats?.find(chat => chat.chatMid === destination);
    const members = Object.keys(chat?.extra?.['1']?.['4'] || {});
    if (expired || !members.length || members.length > 50 || !members.includes(service.profile?.mid)) return false;
    let cursor = 0, found = false;
    await Promise.all(Array.from({ length: Math.min(4, members.length) }, async () => {
      while (!expired && !found && cursor < members.length) {
        const member = members[cursor++];
        const capability = await service.client.negotiateE2EEPublicKey(member);
        if (expired) return;
        if (capability?.['3'] !== -1 && capability?.['3'] !== -1n) continue;
        const contacts = await service.client.getContacts([member]);
        if (!expired && contacts?.some(contact => contact.mid === member && contact.isOfficial === true)) found = true;
      }
    }));
    return !expired && found;
  };
  try {
    return await Promise.race([inspect(), new Promise(resolve => {
      timer = setTimeout(() => { expired = true; resolve(false); }, timeoutMs);
    })]);
  } catch { expired = true; return false; }
  finally { expired = true; clearTimeout(timer); }
}

// Check destination key availability before entering running or marking IDs sent.
// Encryption prepares an in-memory payload only; no message is posted here.
export async function prepareRelayDestination(service, destination, { diagnosticTimeoutMs = 5000 } = {}) {
  try {
    await service.e2eeManager.encryptE2EEMessage(destination, '', 0);
    return 'e2ee';
  } catch (error) {
    if (/^[cr][a-zA-Z0-9_-]{1,80}$/.test(destination)
      && error?.message?.startsWith(`No existing LINE group E2EE key for ${destination};`)
      && await hasUnsupportedBot(service, destination, diagnosticTimeoutMs)) return 'transport';
    throw error;
  }
}
