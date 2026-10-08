import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function localRequest(req, port) {
  return req.headers.host === `127.0.0.1:${port}`
    && (!req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}`)
    && (!req.headers['sec-fetch-site'] || ['none', 'same-origin'].includes(req.headers['sec-fetch-site']));
}
export function authorized(req, token) {
  const supplied = Buffer.from(String(req.headers['x-probe-token'] || ''));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '請使用 JSON 請求');
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 4096) throw new HttpError(413, '請求內容過大');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'JSON 格式不正確'); }
}
export function hardenServer(server) {
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  return server;
}
