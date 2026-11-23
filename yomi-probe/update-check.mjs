// Manual "check for updates": one read-only request to the public GitHub Releases API when the
// user presses the button. Nothing is downloaded, installed or executed, and nothing runs on a timer.
import { HttpError } from './local-http.mjs';
import { APP_VERSION } from './user-tools.mjs';

const REPOSITORY = 'b40609/LinePort';
const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const parse = value => { const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(value || '')); return match ? match.slice(1).map(Number) : null; };
export function compareVersions(a, b) {
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new Error('Invalid version');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120);

export async function checkForUpdate({ current = APP_VERSION, request = fetch } = {}) {
  let release;
  try {
    const response = await request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LinePort-update-check' }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    release = await response.json();
  } catch { throw new HttpError(502, '無法連到 GitHub 檢查新版；請確認網路後再試，或直接開啟發行頁查看'); }
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  if (!parse(tag) || release.draft === true || release.prerelease === true) throw new HttpError(502, 'GitHub 回應的版本資訊無法辨識；請直接開啟發行頁查看');
  // Only ever link to this repository's release page; never follow a URL taken from the response.
  const url = `${RELEASES}/tag/${encodeURIComponent(tag)}`;
  return { current, latest: tag.replace(/^v/, ''), newer: compareVersions(tag, current) > 0, name: clean(release.name), publishedAt: typeof release.published_at === 'string' ? clean(release.published_at) : '', url };
}
