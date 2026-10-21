import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lineDevice } from './line-device.mjs';

// Stage the new runtime before releasing the old listener. Never log in, revoke
// a session or transfer credentials when changing the process-wide identity.
export async function prepareDeviceRestart(device, { entry = fileURLToPath(new URL('./server.mjs', import.meta.url)), timeout = 45000 } = {}) {
  lineDevice(device);
  const child = fork(entry, [], {
    env: { ...process.env, LINEPORT_LINE_DEVICE: device, LINEPORT_STAGED_START: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
  });
  function waitFor(expected) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Device restart timed out')), timeout);
      function finish(error) {
        clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', failed);
        error ? reject(error) : resolve();
      }
      function message(value) { if (value?.type === expected && value.device === device) finish(); }
      function exited() { finish(new Error('Device process exited')); }
      function failed() { finish(new Error('Device process failed')); }
      child.on('message', message); child.once('exit', exited); child.once('error', failed);
      if (child.exitCode !== null || child.signalCode !== null) exited();
    });
  }
  const cancel = () => { if (child.connected) child.disconnect(); child.kill(); };
  try { await waitFor('prepared'); }
  catch (error) { cancel(); throw error; }
  return {
    cancel,
    async activate(server) {
      // close() stops accepting new requests immediately and drains existing ones.
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      try {
        const ready = waitFor('listening');
        child.send({ type: 'activate' }, error => { if (error) child.kill(); });
        await ready;
        child.disconnect(); child.unref();
      } catch (error) {
        const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
        cancel(); await exited;
        // A failed bind must not strand the user with no local UI.
        await new Promise((resolve, reject) => {
          const failed = error => reject(error);
          server.once('error', failed);
          server.listen(server.lineportPort, '127.0.0.1', () => { server.off('error', failed); resolve(); });
        });
        throw error;
      }
    },
  };
}

export async function stagedListen(server, device, port = 18765) {
  if (process.env.LINEPORT_STAGED_START === '1') {
    if (!process.send) throw new Error('Staged startup requires IPC');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Activation timed out')); process.exitCode = 1; process.disconnect(); }, 60000);
      const disconnected = () => { clearTimeout(timer); process.exit(1); };
      process.once('disconnect', disconnected);
      process.on('message', function activate(value) {
        if (value?.type !== 'activate') return;
        clearTimeout(timer); process.off('disconnect', disconnected); process.off('message', activate); resolve();
      });
      process.send({ type: 'prepared', device });
    });
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  if (process.send && process.env.LINEPORT_STAGED_START === '1') process.send({ type: 'listening', device });
}
