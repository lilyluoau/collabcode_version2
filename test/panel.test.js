'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function panel() {
  const nodes = new Map(), sent = [];
  function element() {
    return { value: '', textContent: '', hidden: true, children: [], handlers: {},
      addEventListener(event, handler) { this.handlers[event] = handler; },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; }, scrollIntoView() {},
      get firstElementChild() { return { remove: () => this.children.shift() }; } };
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  let receive;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/media/panel.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
    document: { getElementById: get, createElement: element, createTextNode: text => ({ textContent: text }) },
    window: { addEventListener: (_name, fn) => { receive = fn; } }
  });
  return { get, sent, receive: data => receive({ data }), click: id => get(id).handlers.click() };
}
test('dirty notes keep their original base revision after a remote update', () => {
  const p = panel();
  p.receive({ type: 'init', room: 'demo', name: 'Lily', epoch: 'e', notes: { text: 'base', revision: 1 }, chat: [] });
  p.get('notes').value = 'local draft';
  p.receive({ type: 'notes', text: 'remote', revision: 2, epoch: 'e' });
  assert.equal(p.get('notes').value, 'local draft');
  p.click('save-notes');
  assert.equal(p.sent.at(-1).baseRevision, 1);
  assert.equal(p.sent.at(-1).epoch, 'e');
});
test('loading newer notes backs up a divergent local draft', () => {
  const p = panel();
  p.receive({ type: 'init', room: 'demo', name: 'Lily', epoch: 'e', notes: { text: '', revision: 0 }, chat: [] });
  p.get('notes').value = 'do not lose this';
  p.receive({ type: 'notes', text: 'remote', revision: 1, epoch: 'e', force: true });
  assert.equal(p.get('backup').value, 'do not lose this');
  assert.equal(p.get('backup-section').hidden, false);
  assert.equal(p.get('notes').value, 'remote');
});
test('own notes acknowledgment keeps typing that happened after publish', () => {
  const p = panel();
  p.receive({ type: 'init', room: 'demo', name: 'Lily', epoch: 'e', notes: { text: '', revision: 0 }, chat: [] });
  p.get('notes').value = 'first';
  p.click('save-notes');
  p.get('notes').value = 'first plus second';
  p.receive({ type: 'notes', text: 'first', revision: 1, epoch: 'e', own: true });
  assert.equal(p.get('notes').value, 'first plus second');
  p.click('save-notes');
  assert.equal(p.sent.at(-1).baseRevision, 1);
});
test('chat payload and username are inserted as literal text', () => {
  const p = panel();
  p.receive({ type: 'chat', name: '<img onerror=alert(1)>', text: '<script>bad()</script>' });
  const parts = p.get('chat').children[0].children;
  assert.equal(parts[0].textContent, '<img onerror=alert(1)>: ');
  assert.equal(parts[1].textContent, '<script>bad()</script>');
});
