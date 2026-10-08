const installed = Symbol('linecall-transport-guard');

// Yomi 0.5.0 can resolve transport timeouts as {error}, which query parsers
// otherwise turn into empty message arrays. Never classify those as success.
export function guardProtocol(Client) {
  const prototype = Client.prototype;
  if (prototype[installed]) return;
  const original = prototype.sendCompact;
  if (typeof original !== 'function') throw new Error('Unsupported protocol client');
  prototype.sendCompact = async function (...args) {
    const result = await original.apply(this, args);
    if (!result || result.error || result.statusCode >= 400) throw new Error('Protocol transport failed');
    if (['getRecentMessagesV2', 'getPreviousMessagesV2WithRequest'].includes(args[1]) && !Object.hasOwn(result.fields || {}, '0')) {
      throw new Error('Missing message response');
    }
    return result;
  };
  prototype[installed] = true;
}
