import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeConfig } from './route-config.mjs';

// Exercise the shipped editor with synthetic DOM and API data only.
async function editor() {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  function element(tag = '') {
    return {
      tag, value: '', textContent: '', checked: false, selected: false, dataset: {}, children: [], attributes: {},
      classList: { toggle() {} }, setAttribute(key, value) { this.attributes[key] = value; },
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      get options() { return this.children; }, get selectedOptions() { return this.children.filter(node => node.selected); },
      querySelectorAll(selector) {
        const descendants = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
        return selector === '*' ? descendants : descendants.filter(node => node.tag === 'input' &&
          (selector === 'input:checked' ? node.checked : node.type === 'text' && node.dataset.senderId));
      },
    };
  }
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element()]));
  let saved;
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: element, createTextNode: text => Object.assign(element(), { textContent: text }) },
    structuredClone, crypto: { randomUUID: () => 'synthetic-rule' }, setTimeout, clearTimeout,
    fetch: async (url, request) => {
      if (url.endsWith('/source/senders')) return { ok: true, json: async () => ({ senders: [{ id: 'uone', name: '◇ . ◇' }], explanation: 'Mock members' }) };
      assert.equal(url, '/api/rules');
      saved = normalizeConfig(JSON.parse(request.body));
      return { ok: true, json: async () => ({ config: saved, revision: 'mock-revision' }) };
    },
  });
  vm.runInContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1].replace('controls();void heartbeat();', 'controls();'), context);
  vm.runInContext("relayState={phase:'stopped'};lastState={connected:true};endpoints=[{platform:'line',id:'csource',name:'Source'},{platform:'line',id:'cother',name:'Other'},{platform:'line',id:'cdest',name:'Destination'}];populate();", context);
  const select = (id, value) => { for (const option of nodes.get(id).options) option.selected = option.value === value; };
  select('source', 'line:csource'); select('destination', 'line:cdest');
  vm.runInContext('populateSenderSources()', context);
  nodes.get('ruleName').value = 'Synthetic test';
  const run = code => vm.runInContext(code, context);
  const alias = () => nodes.get('recentSenders').querySelectorAll('input[type="text"][data-sender-id]')[0];
  return { nodes, run, alias, saved: () => saved };
}

test('sender editor saves visible alias without input event and restores alias before platform name', async () => {
  const ui = await editor();
  await ui.nodes.get('loadSenders').onclick();
  ui.alias().value = ' Local member ';
  ui.nodes.get('recentSenders').children[0].children[0].children[0].checked = true;
  ui.nodes.get('addSenders').onclick();
  await ui.nodes.get('saveRule').onclick();
  assert.equal(ui.nodes.get('notice').textContent, '');
  assert.equal(ui.saved().rules[0].senderAliases['line:csource'].uone, 'Local member');
  assert.deepEqual(ui.saved().rules[0].senderAllowlist['line:csource'], ['uone']);
  assert.equal(ui.nodes.get('recentSenders').children.length, 0);
  ui.run("const restored=config.rules[0];for(const option of $('source').options)option.selected=option.value==='line:csource';loadEditorOptions(restored);");
  await ui.nodes.get('loadSenders').onclick();
  assert.equal(ui.alias().value, 'Local member');
  const label = ui.nodes.get('recentSenders').children[0].children[0];
  assert.match(label.children[1].textContent, /Local member（平台名稱：◇ . ◇）/);
  assert.match(ui.run('senderSummary(config.rules[0])'), /Local member/);
  ui.alias().value = ''; ui.alias().oninput();
  assert.match(label.children[1].textContent, /◇ . ◇/);
  assert.equal(ui.run('Object.keys(editorOptions().senderAliases).length'), 0);
});

test('switching sources and reloading preserves uncommitted aliases per source', async () => {
  const ui = await editor();
  await ui.nodes.get('loadSenders').onclick();
  ui.alias().value = 'First';
  ui.nodes.get('senderSource').value = 'line:cother'; ui.nodes.get('senderSource').onchange();
  assert.equal(ui.run("senderAliases['line:csource'].uone"), 'First');
  ui.nodes.get('senderSource').value = 'line:csource'; ui.nodes.get('senderSource').onchange();
  await ui.nodes.get('loadSenders').onclick();
  assert.equal(ui.alias().value, 'First');
  ui.alias().value = 'Updated';
  await ui.nodes.get('loadSenders').onclick();
  assert.equal(ui.alias().value, 'Updated');
  // Opening another rule must not import aliases from the previous editor.
  ui.run("loadEditorOptions({senderAllowlist:{}})");
  assert.equal(ui.run('Object.keys(senderAliases).length'), 0);
});
