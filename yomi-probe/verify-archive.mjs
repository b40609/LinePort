import { verifySnapshot } from './storage-health.mjs';

if (!process.argv[2] || process.argv.length !== 3) {
  process.stderr.write('Usage: node verify-archive.mjs <private-archive-directory>\n');
  process.exitCode = 1;
} else {
  try { process.stdout.write(JSON.stringify(await verifySnapshot(process.argv[2])) + '\n'); }
  catch { process.stderr.write('封存驗證失敗；原資料未變更，請保留原資料與封存並核對完整性。\n'); process.exitCode = 1; }
}
