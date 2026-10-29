import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageText, matchKeywordRule, formatTaipeiTime, resolveSenderName } from './text-template.mjs';

test('renderMessageText preserves literal prefix without variables', () => {
  const result = renderMessageText({
    prefix: '[轉發] ',
    message: { text: '今日盤勢震盪' },
  });
  assert.equal(result, '[轉發] 今日盤勢震盪');
});

test('renderMessageText interpolates prefix with variables', () => {
  const result = renderMessageText({
    prefix: '[{source} / {sender}] ',
    message: { text: '買進 2330', from: 'u123', createdTime: 1700000000000 },
    source: { name: '投資閒聊群', platform: 'line', id: 'c1' },
    rule: { senderAliases: { 'line:c1': { u123: '土88' } } },
  });
  assert.equal(result, '[投資閒聊群 / 土88] 買進 2330');
});

test('renderMessageText renders full custom template', () => {
  const template = '來自: {source}\n發訊者: {sender}\n時間: {timeShort}\n內文:\n{text}';
  const result = renderMessageText({
    template,
    message: { text: '目標價 1200', from: 'u123', createdTime: 1700000000000 },
    source: { name: '投資群', platform: 'line', id: 'c1' },
    rule: { senderAliases: { 'line:c1': { u123: '土88' } } },
  });
  assert.ok(result.includes('來自: 投資群'));
  assert.ok(result.includes('發訊者: 土88'));
  assert.ok(result.includes('內文:\n目標價 1200'));
});

test('matchKeywordRule handles literal matching case-insensitively', () => {
  assert.equal(matchKeywordRule('TSMC 今日收盤上漲', 'tsmc'), true);
  assert.equal(matchKeywordRule('TSMC 今日收盤上漲', '聯發科'), false);
});

test('matchKeywordRule handles AND logic with + and AND', () => {
  assert.equal(matchKeywordRule('2330 今日買進加碼', '2330 + 買進'), true);
  assert.equal(matchKeywordRule('2330 今日賣出停損', '2330 + 買進'), false);
  assert.equal(matchKeywordRule('台積電 盤中買進', '台積電 AND 買進'), true);
  assert.equal(matchKeywordRule('台積電 盤中觀望', '台積電 AND 買進'), false);
});

test('matchKeywordRule handles Regex patterns safely', () => {
  assert.equal(matchKeywordRule('台股大盤指數漲幅 1.5%', '/指數漲幅\\s+\\d+(\\.\\d+)?%/'), true);
  assert.equal(matchKeywordRule('大盤持平', '/指數漲幅\\s+\\d+(\\.\\d+)?%/'), false);
  // Invalid regex falls back safely without throwing
  assert.equal(matchKeywordRule('test', '/[invalid(/'), false);
});
