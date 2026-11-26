// Shared by every outbound HTTP client: classify network exceptions without ever reading their
// (possibly token-bearing) messages. Only failures that provably happened before a connection was
// established count as "never sent"; timeouts, aborts, resets and anything unknown stay uncertain.
const UNSENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
const unsentCode = code => typeof code === 'string' && (UNSENT_CODES.has(code) || code.startsWith('ERR_TLS_'));
export function requestNeverSent(error) {
  if (!error || error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const cause = error.cause;
  // An aggregate (several connection attempts) counts only when every attempt failed before connecting.
  const nested = Array.isArray(cause?.errors) ? cause.errors : Array.isArray(error.errors) ? error.errors : [];
  if (nested.length) return nested.every(item => unsentCode(item?.code));
  return unsentCode(error.code) || unsentCode(cause?.code);
}

// Coarse, loggable class of a failed request whose outcome is unknown ("timeout" or "network" plus a
// fixed Node/undici error code). Like requestNeverSent, it never reads error messages.
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,39}$/;
export function networkFailure(error) {
  if (!error) return { failure: 'unknown' };
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return { failure: 'timeout' };
  const nested = Array.isArray(error.cause?.errors) ? error.cause.errors : Array.isArray(error.errors) ? error.errors : [];
  const code = [error.code, error.cause?.code, ...nested.map(item => item?.code)].find(value => typeof value === 'string' && SAFE_CODE.test(value));
  if (!code) return { failure: 'unknown' };
  return { failure: /TIMEOUT|ETIMEDOUT/.test(code) ? 'timeout' : 'network', code };
}
