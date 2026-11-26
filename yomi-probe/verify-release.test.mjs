import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { checkReleaseReadiness } from './verify-release.mjs';

test('LP-X-06 gate self-test: rejects version drift, missing unverified disclosure, and leaked supergroup IDs', async t => {
  const fakeRepo = await mkdtemp(path.join(os.tmpdir(), 'lineport-gate-'));
  t.after(() => rm(fakeRepo, { recursive: true, force: true }));
  await mkdir(path.join(fakeRepo, 'yomi-probe'), { recursive: true });
  await mkdir(path.join(fakeRepo, 'docs'), { recursive: true });
  await mkdir(path.join(fakeRepo, 'src', 'LinePort.Launcher'), { recursive: true });

  await writeFile(path.join(fakeRepo, 'yomi-probe', 'package.json'), JSON.stringify({ name: 'lineport', version: '1.2.0' }));
  await writeFile(path.join(fakeRepo, 'yomi-probe', 'server.mjs'), 'export const ok = 1;\n');
  await writeFile(path.join(fakeRepo, 'yomi-probe', 'relay.mjs'), 'export const ok = 1;\n');
  await writeFile(path.join(fakeRepo, 'src', 'LinePort.Launcher', 'LinePort.Launcher.csproj'), '<Project><PropertyGroup><Version>1.2.0</Version></PropertyGroup></Project>');
  await writeFile(path.join(fakeRepo, 'README.md'), 'Release-v1.0.0-blue Security-Cloudflare%20Audit%20Verified /releases/tag/v1.0.0');
  await writeFile(path.join(fakeRepo, 'docs', 'PORTABLE.md'), 'v1.0.0-rc.2 說明');
  await writeFile(path.join(fakeRepo, 'docs', 'RELEASE-1.2.0.md'), '# v1.2.0 更新說明\n全部完成');
  await writeFile(path.join(fakeRepo, 'SECURITY.md'), 'v0.8.3');
  await writeFile(path.join(fakeRepo, 'yomi-probe', 'README.md'), 'v0.5.0');
  await writeFile(path.join(fakeRepo, 'VERIFICATION.md'), 'v0.8.3');
  await writeFile(path.join(fakeRepo, 'yomi-probe', 'VERIFICATION.md'), 'v1.0.0 telegram:-1009876543210');
  await writeFile(path.join(fakeRepo, 'HANDOFF.md'), 'ok');

  const bad = checkReleaseReadiness({ repoRoot: fakeRepo, ciMode: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some(p => p.includes('README.md badge')));
  assert.ok(bad.problems.some(p => p.includes('Cloudflare Audit')));
  assert.ok(bad.problems.some(p => p.includes('docs/PORTABLE.md')));
  assert.ok(bad.problems.some(p => p.includes('未實機驗證')));
  assert.ok(bad.problems.some(p => p.includes('unmasked_supergroup_id')));

  // Fix every violation and verify the gate turns green.
  await writeFile(path.join(fakeRepo, 'README.md'), 'Release-v1.2.0-2563eb /releases/download/v1.2.0/x');
  await writeFile(path.join(fakeRepo, 'docs', 'PORTABLE.md'), 'LinePort v1.2.0 免安裝與安裝版說明');
  await writeFile(path.join(fakeRepo, 'docs', 'RELEASE-1.2.0.md'), '# v1.2.0\n## 已知限制與未實機驗證\n- 待驗收');
  await writeFile(path.join(fakeRepo, 'SECURITY.md'), '目前 v1.2.0');
  await writeFile(path.join(fakeRepo, 'yomi-probe', 'README.md'), '# LinePort v1.2.0');
  await writeFile(path.join(fakeRepo, 'VERIFICATION.md'), 'v1.2.0');
  await writeFile(path.join(fakeRepo, 'yomi-probe', 'VERIFICATION.md'), 'v1.2.0 telegram:-100XXXXXXXXXX');

  const good = checkReleaseReadiness({ repoRoot: fakeRepo, ciMode: true });
  assert.deepEqual(good.problems, []);
  assert.equal(good.ok, true);
});

test('repository passes release readiness check in CI mode', () => {
  const result = checkReleaseReadiness({ ciMode: true });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});
