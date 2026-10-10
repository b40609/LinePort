import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTelegramClient } from './telegram.mjs';
import { sendLinePhoto } from './line-media.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { normalizeConfig } from './route-config.mjs';
import { previewRules } from './user-tools.mjs';

const photo = { kind: 'photo', fileId: 'SYNTHETIC_PHOTO', fileSize: 4, caption: '通知' };
const bytes = Buffer.from([255, 216, 255, 217]), prepared = { bytes, fileName: 'image.jpg' };
const config = () => normalizeConfig({ version: 1, rules: [{ id: 'photo', name: '圖片通知', enabled: true, media: true,
  sources: [{ platform: 'telegram', id: '-1', name: '來源' }],
  destinations: [{ platform: 'line', id: 'cdestination', name: 'LINE 目的' }, { platform: 'telegram', id: '-2', name: 'TG 目的' }] }] });
function client({ metadata, body = bytes, status = 200, fail = false } = {}) {
  const requests = [];
  const value = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', { request: async (url, options) => {
    requests.push({ url, options }); if (fail) throw new Error(url);
    if (url.endsWith('/getFile')) return { ok: true, json: async () => ({ ok: true, result: metadata || { file_id: photo.fileId, file_size: photo.fileSize, file_path: 'photos/test.jpg' } }) };
    return new Response(body, { status });
  } });
  return { value, requests };
}
test('photo download validates bounded stream, size, paths and JPEG/PNG signatures and redacts network errors', async () => {
  const good = client(); assert.deepEqual(await good.value.downloadPhoto(photo), prepared);
  assert.equal(good.requests.length, 2); assert.equal(good.requests[1].options.redirect, 'error'); assert.ok(good.requests[1].options.signal);
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  assert.equal((await client({ body: png, metadata: { file_id: photo.fileId, file_size: 8, file_path: 'photos/test.png' } }).value.downloadPhoto({ ...photo, fileSize: 8 })).fileName, 'image.png');
  for (const options of [
    { metadata: { file_id: photo.fileId, file_size: 4, file_path: 'photos/../private' } },
    { metadata: { file_id: photo.fileId, file_size: 5, file_path: 'photos/test.jpg' } },
    { metadata: { file_id: photo.fileId, file_size: 4, file_path: 'https://evil.test/x' } },
    { body: bytes.subarray(0,3) }, { body: Buffer.concat([bytes,bytes]) }, { body: Buffer.from('HTML') }, { status: 302 }, { fail: true },
  ]) await assert.rejects(client(options).value.downloadPhoto(photo), error => /尚未呼叫 LINE/.test(error.message) && !error.message.includes('SYNTHETIC_TOKEN'));
  await assert.rejects(client().value.downloadPhoto({ ...photo, kind: 'document' }), /只支援圖片/);
});
test('public LINE image API separately confirms caption and reports both output IDs', async () => {
  const calls = [], service = { sendImage: async (...args) => { calls.push(args); return { messageId: '123' }; },
    sendMessage: async (...args) => { calls.push(args); return { id: '124' }; } };
  assert.deepEqual(await sendLinePhoto(service,'cdestination',photo,prepared), { id: '124', ids: ['123','124'] });
  assert.deepEqual(calls, [['cdestination',bytes,'image.jpg'],['cdestination','通知']]);
  calls.length = 0;
  assert.deepEqual(await sendLinePhoto(service,'cdestination',{ ...photo,caption:'' },prepared), { id:'123',ids:['123'] });
  assert.equal(calls.length,1); service.sendImage = async () => ({});
  await assert.rejects(sendLinePhoto(service,'cdestination',photo,prepared), /不要直接重送/); assert.equal(calls.length,1);
});
async function fixture({ prepare, captionFailure = false, imageResponse } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'lineport-media-')), calls = [];
  const telegram = { identity:'synthetic-tg',recent:async()=>[],read:async()=>[{ id:'-1:1',text:photo.caption,media:photo,from:'123',createdTime:1100 }],prepare:async()=>{},
    send:async()=>{ calls.push('tg');return {id:'-2:1'}; } };
  const service = { sendImage:async()=>{ calls.push('image');return imageResponse ? await imageResponse : {messageId:'123'}; },
    sendMessage:async()=>{ calls.push('caption');if(captionFailure)throw new Error('synthetic missing ack');return {id:'124'}; } };
  const line = { identity:'synthetic-line',prepare:async()=>{},preparePayload:prepare|| (async()=>prepared),send:(id,payload,options)=>sendLinePhoto(service,id,payload,options.prepared,options) };
  return {calls,directory,telegram,options:{directory,config:config(),adapters:{line,telegram},now:()=>1000,pause:async()=>{}}};
}
test('preparation failure preserves pending without uncertain send; offline-source restart recovers and tracks both outputs', async () => {
  const f = await fixture({prepare:async()=>{throw new Error('synthetic offline download');}});
  const relay = await createMultiRelay(f.options);await relay.tick();
  const line = relay.state.routes.find(row=>row.destination.platform==='line');
  assert.equal(line.phase,'failed');assert.equal(line.pending,1);assert.equal(line.uncertain,0);assert.deepEqual(f.calls,['tg']);
  f.options.adapters.line.preparePayload=async()=>prepared;f.telegram.read=async()=>{throw new Error('synthetic offline source');};
  const restarted=await createMultiRelay(f.options);await restarted.tick();assert.deepEqual(f.calls,['tg','image','caption']);
  assert.equal(restarted.state.routes.find(row=>row.destination.platform==='line').pending,0);
  const outputs=await readFile(path.join(f.directory,'lineport-output.jsonl'),'utf8');assert.match(outputs,/cdestination:123/);assert.match(outputs,/cdestination:124/);
  assert.ok((await readdir(f.directory)).every(name=>!/jpg|png/.test(name)));
});
test('caption failure after image acceptance blocks restart without repeating either part', async () => {
  const f=await fixture({captionFailure:true}), relay=await createMultiRelay(f.options);await relay.tick();
  assert.deepEqual([...f.calls].sort(),['caption','image','tg']);assert.equal(relay.state.routes.find(row=>row.destination.platform==='line').phase,'blocked');
  const restarted=await createMultiRelay(f.options);await restarted.tick();assert.equal(f.calls.length,3);
  assert.equal(restarted.state.routes.find(row=>row.destination.platform==='line').phase,'blocked');
});
test('late image acknowledgement after deadline never starts caption or retries on restart', async () => {
  let resolveImage;
  const imageResponse = new Promise(resolve => { resolveImage = resolve; });
  const f = await fixture({ imageResponse }); f.options.operationTimeoutMs = 20;
  const relay = await createMultiRelay(f.options); await relay.tick();
  assert.equal(relay.state.routes.find(row => row.destination.platform === 'line').phase, 'blocked');
  resolveImage({ messageId: '123' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...f.calls].sort(), ['image', 'tg']);
  const restarted = await createMultiRelay(f.options); await restarted.tick();
  assert.deepEqual([...f.calls].sort(), ['image', 'tg']);
});

test('preview allows photos but rejects LINE documents and unsupported reply association', () => {
  const value=config(), input={config:value,source:'telegram:-1',text:'通知',media:{kind:'photo',fileSize:4}};
  assert.ok(previewRules(input).results[0].destinations.every(row=>row.eligible));
  const documents=previewRules({...input,media:{kind:'document',fileSize:4}}).results[0].destinations;
  assert.equal(documents[0].eligible,false);assert.match(documents[0].reason,/保留待送/);assert.equal(documents[1].eligible,true);
  value.rules[0].replies=true;assert.throws(()=>normalizeConfig(value),/關閉回覆/);
});
