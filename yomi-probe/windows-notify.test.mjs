import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyWindows } from './windows-notify.mjs';

test('notifyWindows throttles repeated calls within throttleMs', () => {
  const calls = [];
  const fakeRunner = (cmd, args) => {
    calls.push({ cmd, args });
    return { unref: () => {} };
  };
  const first = notifyWindows('Title1', 'Message1', { throttleMs: 5000, runner: fakeRunner });
  const second = notifyWindows('Title2', 'Message2', { throttleMs: 5000, runner: fakeRunner });
  if (process.platform === 'win32') {
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls.length, 1);
  } else {
    assert.equal(first, false);
    assert.equal(second, false);
  }
});

test('notifyWindows sanitizes special characters safely', () => {
  const calls = [];
  const fakeRunner = (cmd, args) => {
    calls.push({ cmd, args });
    return { unref: () => {} };
  };
  notifyWindows('Dangerous "Title" $VAR `CMD`\r\nmalicious; echo 1', 'Safe\nmessage; & exit', { throttleMs: 0, runner: fakeRunner });
  if (process.platform === 'win32') {
    const script = calls[calls.length - 1].args[4];
    assert.ok(!script.includes('"Dangerous "Title"'));
    assert.ok(!script.includes('$VAR'));
    assert.ok(!script.includes('`CMD`'));
    assert.ok(!script.includes('\n'));
    assert.ok(!script.includes(';'));
    assert.ok(!script.includes('&'));
  }
});
