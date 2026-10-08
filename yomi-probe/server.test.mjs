import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { createProbeServer } from './server.mjs';

const fakeToken = 'test-only-token';
async function setup(t, overrides = {}) {
  const service = Object.assign(new EventEmitter(), { resumeSession: async () => true, client: { getAllChatMids: async () => ({ memberChats: [] }), getChats: async () => [] } }, overrides);
  const server = createProbeServer({ service, token: fakeToken, runPwlessLogin: async () => {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  function startRequest(route, headers = {}, method = 'POST') {
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request({ hostname: '127.0.0.1', port, path: route, method,
        headers: { Host: '127.0.0.1:18765', 'X-Probe-Token': fakeToken, 'Content-Type': 'application/json', ...headers } }, res => {
        const parts = [];
        res.on('data', p => parts.push(p));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
      });
      request.on('error', reject);
    });
    return { request, response };
  }
  async function call(route, value = '{}', headers = {}, method = 'POST') {
    const { request, response } = startRequest(route, headers, method);
    request.end(method === 'GET' ? undefined : value);
    return response;
  }
  return { call, startRequest };
}
test('local API enforces Host, Origin, Fetch Metadata and token', async t => {
  const { call } = await setup(t);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Probe-Token': 'wrong' }]) {
    assert.equal((await call('/api/status', undefined, headers, 'GET')).status, 403);
  }
  assert.equal((await call('/api/status', undefined, {}, 'GET')).status, 200);
});
test('home has nonce CSP, no-store and no unresolved placeholders', async t => {
  const { call } = await setup(t);
  const result = await call('/', undefined, {}, 'GET');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-security-policy'], /script-src 'nonce-/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.ok(!result.body.includes('__TOKEN__') && !result.body.includes('__NONCE__'));
});
test('malformed bodies rejected; unauthenticated group read blocked', async t => {
  const { call } = await setup(t);
  assert.equal((await call('/api/resume', '{')).status, 400);
  assert.equal((await call('/api/resume', 'null')).status, 400);
  assert.equal((await call('/api/resume', '[]')).status, 400);
  assert.equal((await call('/api/resume', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('/api/resume', JSON.stringify({ text: 'a'.repeat(5000) }))).status, 413);
  assert.equal((await call('/api/groups')).status, 401);
});
test('overlapping request bodies cannot start concurrent session operations', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { call, startRequest } = await setup(t, { resumeSession: async () => { calls++; entered(); await gate; return true; } });
  t.after(() => release());
  const slow = startRequest('/api/resume');
  slow.request.write('{');
  const active = call('/api/resume');
  await began;
  slow.request.end('}');
  assert.equal((await slow.response).status, 409);
  release();
  assert.equal((await active).status, 200);
  assert.equal(calls, 1);
});
test('upstream exceptions never reveal sensitive context', async t => {
  const { call } = await setup(t, { resumeSession: async () => { throw new Error('SYNTHETIC_SECRET'); } });
  const result = await call('/api/resume');
  assert.equal(result.status, 500);
  assert.ok(!result.body.includes('SYNTHETIC_SECRET'));
  assert.ok(!(await call('/api/status', undefined, {}, 'GET')).body.includes('SYNTHETIC_SECRET'));
});
