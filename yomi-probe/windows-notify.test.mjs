import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyWindows, NOTIFY_SCRIPT } from './windows-notify.mjs';

const fake = calls => (cmd, args, options) => { calls.push({ cmd, args, options }); return { unref: () => {}, on: () => {} }; };
const decoded = call => Buffer.from(call.args.at(-1), 'base64').toString('utf16le');

test('notifyWindows throttles repeated calls within throttleMs', () => {
  const calls = [];
  const first = notifyWindows('Title1', 'Message1', { throttleMs: 5000, runner: fake(calls) });
  const second = notifyWindows('Title2', 'Message2', { throttleMs: 5000, runner: fake(calls) });
  if (process.platform === 'win32') {
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls.length, 1);
  } else {
    assert.equal(first, false);
    assert.equal(second, false);
  }
});

test('notifyWindows passes text only through environment values, never the command', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const title = 'Dangerous "Title" $VAR `CMD`\r\nmalicious; echo 1', message = "Safe\nmessage; & exit $(Remove-Item x) </text><text>";
  assert.equal(notifyWindows(title, message, { throttleMs: 0, runner: fake(calls) }), true);
  const call = calls.at(-1);
  assert.equal(call.args[call.args.length - 2], '-EncodedCommand');
  const script = decoded(call);
  assert.equal(script, NOTIFY_SCRIPT);
  for (const fragment of ['Dangerous', '$VAR', '`CMD`', 'malicious', 'Remove-Item']) assert.ok(!script.includes(fragment), fragment);
  assert.ok(!call.args.some(arg => arg.includes('Dangerous')));
  assert.equal(call.options.env.LINEPORT_NOTIFY_TITLE, 'Dangerous "Title" $VAR `CMD`  malicious; echo 1');
  assert.ok(!/[\r\n]/.test(call.options.env.LINEPORT_NOTIFY_MESSAGE));
  assert.equal(call.options.env.LINEPORT_NOTIFY_ICON, 'Warning');
  notifyWindows('t', 'm', { throttleMs: 0, icon: 'Bogus]; Remove-Item', runner: fake(calls) });
  assert.equal(calls.at(-1).options.env.LINEPORT_NOTIFY_ICON, 'Warning');
});

test('notification script XML-escapes text and outlives the balloon instead of disposing after 200 ms', () => {
  assert.match(NOTIFY_SCRIPT, /\[Security\.SecurityElement\]::Escape\(\$env:LINEPORT_NOTIFY_TITLE\)/);
  assert.match(NOTIFY_SCRIPT, /ToastNotificationManager\]::CreateToastNotifier/);
  assert.match(NOTIFY_SCRIPT, /ShowBalloonTip\(10000,[^\n]+\n\s*Start-Sleep -Seconds 12\n\s*\$notify\.Dispose\(\)/);
  assert.ok(!NOTIFY_SCRIPT.includes('Milliseconds 200'));
});
