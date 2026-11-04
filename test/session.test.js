'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionHub } = require('../server/session');
const { DocumentState } = require('../extension/document-state');
const token = 'test-token-at-least-12';
function fixture() {
  const hub = new SessionHub({ alpha: token, beta: token });
  function peer(room = 'alpha', name = 'Lily') {
    const inbox = [];
    const client = hub.connect(message => inbox.push(structuredClone(message)));
    hub.receive(client, { type: 'join', room, token, name });
    return { client, inbox, welcome: inbox[0] };
  }
  return { hub, peer };
}
function edit(welcome, text, baseRevision = 0, document = 'code') {
  return { type: 'publish', epoch: welcome.epoch, document, text, baseRevision, requestId: `edit-${text}` };
}
test('authentication blocks all pre-join operations and bad room tokens', () => {
  const { hub } = fixture();
  const inbox = [], peer = hub.connect(message => inbox.push(message));
  hub.receive(peer, { type: 'chat', text: 'secret' });
  hub.receive(peer, { type: 'join', room: 'alpha', token: 'bad', name: 'X' });
  assert.deepEqual(inbox.map(m => m.code), ['join_required', 'unauthorized']);
  assert.equal(peer.room, null);
});
test('chat, identity and document updates are room isolated', () => {
  const { hub, peer } = fixture();
  const a = peer(), b = peer(), c = peer('beta');
  const before = c.inbox.length;
  hub.receive(a.client, { type: 'chat', text: 'hello', name: 'Spoof', senderId: 'spoof' });
  const message = b.inbox.at(-1);
  assert.equal(message.name, 'Lily');
  assert.equal(message.senderId, a.welcome.id);
  hub.receive(a.client, edit(a.welcome, 'const x = 1;'));
  assert.equal(b.inbox.at(-1).text, 'const x = 1;');
  assert.equal(c.inbox.length, before);
});
test('concurrent edits reject stale revisions without replacing accepted data', () => {
  const { hub, peer } = fixture();
  const a = peer(), b = peer();
  hub.receive(a.client, edit(a.welcome, 'first'));
  hub.receive(b.client, edit(b.welcome, 'second'));
  assert.equal(b.inbox.at(-1).type, 'conflict');
  assert.equal(b.inbox.at(-1).text, 'first');
  assert.equal(hub.rooms.get('alpha').code.revision, 1);
  // Explicit retry from a newly loaded base is accepted.
  hub.receive(b.client, edit(b.welcome, 'merged', 1));
  assert.equal(hub.rooms.get('alpha').code.text, 'merged');
});
test('cursor requires the shared document, epoch, revision and valid offset', () => {
  const { hub, peer } = fixture();
  const a = peer(), b = peer();
  hub.receive(a.client, edit(a.welcome, 'abc'));
  const cursor = { type: 'cursor', document: 'code', epoch: a.welcome.epoch, revision: 1, offset: 2 };
  hub.receive(a.client, cursor);
  assert.equal(b.inbox.at(-1).senderId, a.welcome.id);
  for (const bad of [{ offset: -1 }, { offset: 4 }, { offset: 1.5 }, { revision: 0 }, { document: 'other' }, { epoch: 'old-server' }]) {
    const before = b.inbox.length;
    hub.receive(a.client, { ...cursor, ...bad });
    assert.equal(a.inbox.at(-1).code, 'invalid_cursor');
    assert.equal(b.inbox.length, before);
  }
});
test('disconnect removes presence; rejoin receives current notes and code', () => {
  const { hub, peer } = fixture();
  const a = peer(), b = peer();
  hub.receive(a.client, edit(a.welcome, 'abc'));
  hub.receive(a.client, edit(a.welcome, 'meeting notes', 0, 'notes'));
  hub.disconnect(a.client);
  assert.deepEqual(b.inbox.at(-1).members.map(m => m.id), [b.welcome.id]);
  const c = peer();
  assert.equal(c.welcome.code.text, 'abc');
  assert.equal(c.welcome.notes.text, 'meeting notes');
  assert.notEqual(c.welcome.id, a.welcome.id);
});
test('invalid payloads, room capacity and bounded history', () => {
  const { hub, peer } = fixture();
  const a = peer();
  for (const data of [null, [], { type: 'unknown' }, edit(a.welcome, 'x'.repeat(50001)), { type: 'chat', text: '' }]) hub.receive(a.client, data);
  assert.equal(hub.rooms.get('alpha').code.revision, 0);
  for (let i = 0; i < 120; i++) hub.receive(a.client, { type: 'chat', text: String(i) });
  assert.equal(hub.rooms.get('alpha').chat.length, 100);
  for (let i = 1; i < 20; i++) peer();
  assert.equal(peer().inbox[0].code, 'room_full');
});
test('an old server epoch cannot overwrite a fresh room after restart', () => {
  const old = fixture(), current = fixture();
  const a = old.peer(), b = current.peer();
  current.hub.receive(b.client, edit(a.welcome, 'stale'));
  assert.equal(b.inbox.at(-1).type, 'conflict');
  assert.equal(current.hub.rooms.get('alpha').code.text, '');
});
test('draft edits survive both incoming remote edits and own publish acknowledgements', () => {
  const state = new DocumentState();
  state.initialize('epoch', { revision: 0, text: '' });
  state.request('published', 'request', 'code');
  const ack = { epoch: 'epoch', revision: 1, text: 'published', senderId: 'self', requestId: 'request' };
  assert.deepEqual(state.receive(ack, 'published plus newer typing', 'self'), { apply: false, conflict: false });
  assert.equal(state.baseText, 'published');
  const remote = { epoch: 'epoch', revision: 2, text: 'remote', senderId: 'other' };
  assert.deepEqual(state.receive(remote, 'published plus newer typing', 'self'), { apply: false, conflict: true });
  assert.equal(state.revision, 1);
  assert.equal(state.latest.revision, 2);
});
test('clean document advances to remote version; only one publish is in flight', () => {
  const state = new DocumentState();
  state.initialize('e', { revision: 0, text: '' });
  assert.equal(state.receive({ epoch: 'e', revision: 1, text: 'hello' }, '', 'self').apply, true);
  state.request('one', '1', 'code');
  assert.throws(() => state.request('two', '2', 'code'), /previous publish/);
});
