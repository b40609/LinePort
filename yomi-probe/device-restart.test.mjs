import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareDeviceRestart } from './device-restart.mjs';

const stagedModule = new URL('./device-restart.mjs', import.meta.url).href;
async function fixture(code) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lineport-restart-'));
  const entry = path.join(dir, 'fixture.mjs');
  await writeFile(entry, code);
  return entry;
}
async function listener(t) {
  const server = http.createServer((_req, res) => res.end('original'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  server.lineportPort = server.address().port;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}
function get(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/`, { agent: false }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

test('staged device restart prepares before releasing listener, then activates a fresh identity', async t => {
  const server = await listener(t), port = server.lineportPort;
  const entry = await fixture(`
    import http from 'node:http';
    import { stagedListen } from ${JSON.stringify(stagedModule)};
    const device = process.env.LINEPORT_LINE_DEVICE;
    const server = http.createServer((_req, res) => res.end(device));
    await stagedListen(server, device, ${port});
  `);
  const replacement = await prepareDeviceRestart('DESKTOPWIN', { entry, timeout: 5000 });
  t.after(() => replacement.cancel());
  assert.equal(await get(port), 'original');
  await replacement.activate(server);
  assert.equal(await get(port), 'DESKTOPWIN');
});

test('replacement activation failure restores the original listener', async t => {
  const server = await listener(t), port = server.lineportPort;
  const entry = await fixture(`
    process.send({ type:'prepared', device:process.env.LINEPORT_LINE_DEVICE });
    process.on('message', () => process.exit(1));
  `);
  const replacement = await prepareDeviceRestart('IOSIPAD', { entry, timeout: 5000 });
  await assert.rejects(replacement.activate(server), /exited/);
  assert.equal(await get(port), 'original');
});

test('replacement keeps serving after the original process exits', async t => {
  const childEntry = await fixture(`
    import http from 'node:http';
    import { stagedListen } from ${JSON.stringify(stagedModule)};
    const server = http.createServer((req, res) => {
      res.end(process.env.LINEPORT_LINE_DEVICE);
      if (req.url === '/stop') server.close(() => process.exit(0));
    });
    await stagedListen(server, process.env.LINEPORT_LINE_DEVICE, Number(process.env.TEST_RESTART_PORT));
    setTimeout(() => server.close(() => process.exit(0)), 10000).unref();
  `);
  const parentEntry = await fixture(`
    import http from 'node:http';
    import { once } from 'node:events';
    import { prepareDeviceRestart } from ${JSON.stringify(stagedModule)};
    const server = http.createServer((_req, res) => res.end('original'));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    server.lineportPort = server.address().port;
    process.env.TEST_RESTART_PORT = String(server.lineportPort);
    const replacement = await prepareDeviceRestart('DESKTOPWIN', { entry: ${JSON.stringify(childEntry)}, timeout: 5000 });
    await replacement.activate(server);
    process.stdout.write(String(server.lineportPort));
    process.exit(0);
  `);
  const { stdout } = await promisify(execFile)(process.execPath, [parentEntry], { windowsHide: true, timeout: 7000 });
  const port = Number(stdout);
  t.after(() => new Promise(resolve => {
    http.get(`http://127.0.0.1:${port}/stop`, { agent: false }, res => { res.resume(); res.on('end', resolve); }).on('error', resolve);
  }));
  assert.equal(await get(port), 'DESKTOPWIN');
});

test('replacement preparation timeout leaves original service available', async t => {
  const server = await listener(t);
  const entry = await fixture(`process.on('message', () => {});`);
  await assert.rejects(prepareDeviceRestart('IOSIPAD', { entry, timeout: 100 }), /timed out/);
  assert.equal(await get(server.lineportPort), 'original');
});

test('unsupported identity fails before spawning a child', async () => {
  await assert.rejects(prepareDeviceRestart('UNKNOWN', { entry: 'nonexistent.mjs' }), /Unsupported/);
});
