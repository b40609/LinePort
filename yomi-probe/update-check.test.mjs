import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkForUpdate, compareVersions } from './update-check.mjs';
import { APP_VERSION } from './user-tools.mjs';

const reply = (body, status = 200) => async (url, options) => {
  reply.last = { url, options };
  return new Response(JSON.stringify(body), { status });
};

test('versions compare numerically and reject anything else', () => {
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0', 'v1.1.0'), 0);
  assert.equal(compareVersions('1.0.2', '1.1.0'), -1);
  assert.throws(() => compareVersions('1.1', '1.1.0'));
  assert.throws(() => compareVersions('v1.2.0-beta', '1.1.0'));
});

test('the manual check makes one read-only GitHub request and only links to this repository', async () => {
  const newer = await checkForUpdate({ current: '1.1.0', request: reply({ tag_name: 'v1.2.0', name: '新版\n說明', published_at: '2026-11-24T00:00:00Z', html_url: 'https://evil.example/x' }) });
  assert.deepEqual(newer, { current: '1.1.0', latest: '1.2.0', newer: true, name: '新版 說明', publishedAt: '2026-11-24T00:00:00Z', url: 'https://github.com/b40609/LinePort/releases/tag/v1.2.0' });
  assert.equal(reply.last.url, 'https://api.github.com/repos/b40609/LinePort/releases/latest');
  assert.equal(reply.last.options.method, undefined);
  assert.equal(reply.last.options.redirect, 'error');
  assert.equal((await checkForUpdate({ current: '1.1.0', request: reply({ tag_name: 'v1.0.2' }) })).newer, false);
  assert.equal((await checkForUpdate({ request: reply({ tag_name: `v${APP_VERSION}` }) })).newer, false);
  for (const body of [{ tag_name: 'latest' }, { tag_name: 'v2.0.0', prerelease: true }, { tag_name: 'v2.0.0', draft: true }, null]) {
    await assert.rejects(checkForUpdate({ request: reply(body) }), error => error.status === 502);
  }
  await assert.rejects(checkForUpdate({ request: reply({ message: 'rate limited' }, 403) }), /無法連到 GitHub/);
  await assert.rejects(checkForUpdate({ request: async () => { throw new TypeError('fetch failed'); } }), /無法連到 GitHub/);
});

test('the page only offers the check behind a button and never downloads', async () => {
  const page = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(page, /id="checkUpdate"/);
  assert.match(page, /\$\('checkUpdate'\)\.onclick=\(\)=>act\(/);
  assert.equal((page.match(/api\('update\/check'\)/g) || []).length, 1);
  assert.doesNotMatch(page, /update\/(download|install)/);
});
