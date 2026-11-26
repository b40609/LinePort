import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.dirname(here);

const FORBIDDEN_PATTERNS = [
  { name: 'telegram_bot_token', regex: /\b\d{7,20}:[A-Za-z0-9_-]{30,100}\b/ },
  { name: 'discord_webhook', regex: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/i },
  { name: 'unmasked_supergroup_id', regex: /-100(?!123456789\d?\b|0+\b)\d{9,}/ },
  { name: 'private_key_pem', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

export function checkReleaseReadiness({
  repoRoot = defaultRepoRoot,
  ciMode = false,
  portableDir = '',
} = {}) {
  const problems = [];
  const read = rel => {
    const full = path.join(repoRoot, rel);
    if (!existsSync(full)) {
      problems.push(`missing file: ${rel}`);
      return '';
    }
    return readFileSync(full, 'utf8');
  };

  const pkgText = read('yomi-probe/package.json');
  let version = '';
  try { version = JSON.parse(pkgText).version || ''; } catch { problems.push('invalid yomi-probe/package.json'); }
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
    problems.push(`invalid package version: ${version}`);
    return { ok: false, version, problems };
  }

  // 1. Version alignment across docs and metadata.
  const csproj = read('src/LinePort.Launcher/LinePort.Launcher.csproj');
  const csprojVer = /<InformationalVersion>([^<]+)<\/InformationalVersion>|<Version>([^<]+)<\/Version>/.exec(csproj);
  const launcherVer = (csprojVer?.[1] || csprojVer?.[2] || '').split('+')[0];
  if (launcherVer && launcherVer !== version) {
    problems.push(`Launcher csproj version (${launcherVer}) !== package.json (${version})`);
  }

  const readme = read('README.md');
  if (!readme.includes(`Release-v${version}-`)) problems.push(`README.md badge does not match v${version}`);
  if (!readme.includes(`/releases/download/v${version}/`) && !readme.includes(`/releases/tag/v${version}`)) {
    problems.push(`README.md download links do not point to v${version}`);
  }
  if (/Cloudflare(?:\s|%20)+Audit(?:\s|%20)+Verified/i.test(readme)) {
    problems.push('README.md contains unverified Cloudflare Audit claim');
  }

  const portableDoc = read('docs/PORTABLE.md');
  if (!portableDoc.includes(`v${version}`)) problems.push(`docs/PORTABLE.md (先讀我.md) does not reference v${version}`);
  if (/v1\.0\.0-rc\.\d+/.test(portableDoc)) problems.push('docs/PORTABLE.md still references release-candidate v1.0.0-rc.*');

  const securityDoc = read('SECURITY.md');
  if (!securityDoc.includes(`v${version}`)) problems.push(`SECURITY.md does not reference v${version}`);

  const subReadme = read('yomi-probe/README.md');
  if (!subReadme.includes(`v${version}`)) problems.push(`yomi-probe/README.md does not reference v${version}`);

  const rootVerif = read('VERIFICATION.md');
  if (!rootVerif.includes(`v${version}`)) problems.push(`VERIFICATION.md does not reference v${version}`);

  const probeVerif = read('yomi-probe/VERIFICATION.md');
  if (!probeVerif.includes(`v${version}`)) problems.push(`yomi-probe/VERIFICATION.md does not include v${version} verification record`);

  // 2. Release notes must exist and disclose unverified / known-limitation items.
  const releaseDoc = read(`docs/RELEASE-${version}.md`);
  if (releaseDoc && !/未實機驗證|已知限制/.test(releaseDoc)) {
    problems.push(`docs/RELEASE-${version}.md must include a '未實機驗證' or '已知限制' section`);
  }

  // 3. Scan tracked non-test files for leaked group IDs or credential patterns.
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    // Fallback when git CLI is unavailable: check key docs directly.
    tracked = ['README.md', 'SECURITY.md', 'HANDOFF.md', 'VERIFICATION.md', 'yomi-probe/VERIFICATION.md', 'docs/PORTABLE.md', `docs/RELEASE-${version}.md`];
  }
  for (const rel of tracked) {
    if (rel.endsWith('.test.mjs') || /\.(?:png|jpg|ico|exe|dll|pdf|zip)$/i.test(rel)) continue;
    const full = path.join(repoRoot, rel);
    if (!existsSync(full)) continue;
    let content = '';
    try { content = readFileSync(full, 'utf8'); } catch { continue; }
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.regex.test(content)) {
        problems.push(`${rel}: matched forbidden pattern '${rule.name}'`);
      }
    }
  }

  // 4. Entrypoint syntax check.
  const nodeBin = portableDir ? path.join(portableDir, 'runtime', 'node.exe') : process.execPath;
  const probeRoot = portableDir ? path.join(portableDir, 'yomi-probe') : path.join(repoRoot, 'yomi-probe');
  for (const entry of ['server.mjs', 'relay.mjs']) {
    const target = path.join(probeRoot, entry);
    if (!existsSync(target)) { problems.push(`missing entrypoint: ${target}`); continue; }
    try {
      execFileSync(nodeBin, ['--check', target], { stdio: 'pipe', timeout: 15000, windowsHide: true });
    } catch {
      problems.push(`syntax check failed for ${entry}`);
    }
  }

  // 5. Tag check (required for full release mode, skipped in --ci mode for pre-tag commits).
  if (!ciMode) {
    try {
      const tags = execFileSync('git', ['tag', '-l', `v${version}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (tags !== `v${version}`) problems.push(`git tag v${version} is missing`);
    } catch {
      problems.push(`unable to verify git tag v${version}`);
    }
  }

  // 6. Portable directory hygiene when verifying a built package.
  if (portableDir) {
    if (!existsSync(path.join(portableDir, 'yomi-probe', 'build-info.json'))) {
      problems.push('portable package missing yomi-probe/build-info.json');
    }
  }

  return { ok: problems.length === 0, version, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ciMode = args.includes('--ci');
  const portableIdx = args.indexOf('--portable');
  const portableDir = portableIdx >= 0 ? args[portableIdx + 1] || '' : '';
  const result = checkReleaseReadiness({ ciMode, portableDir });
  if (!result.ok) {
    process.stderr.write(`Release readiness check failed for v${result.version || '?'}:\n` + result.problems.map(p => `  - ${p}\n`).join(''));
    process.exitCode = 1;
  } else {
    process.stdout.write(`Release readiness check passed for v${result.version} (${ciMode ? 'CI' : 'release'} mode).\n`);
  }
}
