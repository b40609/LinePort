// Only IDs are retained; parent message bodies and quoted author details are not copied.
export const validMessageId = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,100}$/.test(value);
export function sourceReply(message, platform, source) {
  if (platform === 'telegram') {
    return destinationReply('telegram', source, message.replyTo) || null;
  }
  return platform === 'line' && message.messageRelationType === 3 && typeof message.relatedMessageId === 'string' && /^[1-9]\d{0,19}$/.test(message.relatedMessageId) ? message.relatedMessageId : null;
}
export function destinationReply(platform, destination, id) {
  if (!validMessageId(id)) return undefined;
  if (platform === 'telegram') {
    const match = /^(-?[1-9]\d{0,15}):([1-9]\d{0,15})$/.exec(id);
    return match && match[1] === destination && Number.isSafeInteger(Number(match[2])) ? id : undefined;
  }
  if (platform === 'line') return /^[1-9]\d{0,19}$/.test(id) ? id : undefined;
  return platform === 'discord' && /^[1-9]\d{5,19}$/.test(id) && BigInt(id) < (1n << 64n) ? id : undefined;
}
