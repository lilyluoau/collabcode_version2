'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../server');
const token = 'integration-test-token';
async function fixture(t, options = {}) {
  const app = createServer({ roomTokens: { a: token, b: token }, ...options });
  const address = await app.listen();
  t.after(() => app.close());
  async function client(room = 'a', wsOptions = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/collab`, wsOptions);
    const queue = [], waiters = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const idx = waiters.findIndex(w => w.match(message));
      if (idx < 0) queue.push(message); else waiters.splice(idx, 1)[0].resolve(message);
    });
    t.after(() => ws.terminate());
    await once(ws, 'open');
    function next(match) {
      const idx = queue.findIndex(match);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: value => { clearTimeout(timeout); resolve(value); } };
        const timeout = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); reject(new Error('Timed out waiting for message')); }, 2000);
        waiters.push(waiter);
      });
    }
    const send = data => ws.send(JSON.stringify(data));
    send({ type: 'join', room, token, name: room });
    const welcome = await next(m => m.type === 'welcome');
    return { ws, next, send, welcome, queue };
  }
  return { app, address, client };
}
test('real sockets exchange edits/cursors; unrelated room stays isolated and disconnect cleans up', async t => {
  const { client, app } = await fixture(t);
  const a = await client(), b = await client(), c = await client('b');
  a.send({ type: 'publish', document: 'code', epoch: a.welcome.epoch, baseRevision: 0, text: 'hello', requestId: '1' });
  assert.equal((await b.next(m => m.type === 'document')).text, 'hello');
  a.send({ type: 'cursor', document: 'code', epoch: a.welcome.epoch, revision: 1, offset: 3 });
  assert.equal((await b.next(m => m.type === 'cursor')).senderId, a.welcome.id);
  // Sync is a round-trip barrier on the unrelated client.
  c.send({ type: 'sync' });
  assert.equal((await c.next(m => m.type === 'snapshot')).code.text, '');
  assert.equal(c.queue.some(m => ['cursor', 'document'].includes(m.type)), false);
  a.ws.close();
  await b.next(m => m.type === 'left' && m.id === a.welcome.id);
  assert.equal(app.hub.rooms.get('a').members.size, 1);
});
test('invalid JSON does not crash server; oversized frames close connection', async t => {
  const { client, address } = await fixture(t);
  const a = await client();
  a.ws.send('{broken');
  assert.equal((await a.next(m => m.type === 'error')).code, 'invalid_json');
  a.send({ type: 'chat', text: 'still works' });
  assert.equal((await a.next(m => m.type === 'chat')).text, 'still works');
  const closed = once(a.ws, 'close');
  a.ws.send('x'.repeat(300000));
  assert.equal((await closed)[0], 1009);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status, 200);
});
test('browser origins and unexpected paths are rejected at upgrade', async t => {
  const { address } = await fixture(t);
  for (const [path, options] of [['/collab', { origin: 'https://untrusted.example' }], ['/wrong', {}]]) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, options);
    ws.on('error', () => {});
    const [error] = await once(ws, 'error');
    assert.match(error.message, /403/);
  }
});
test('heartbeat removes an unresponsive authenticated peer', async t => {
  const { client, app } = await fixture(t, { heartbeatMs: 30 });
  const a = await client('a', { autoPong: false });
  await once(a.ws, 'close');
  // Server-side close callback may be one event-loop turn after client close.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.hub.rooms.get('a').members.size, 0);
});
test('unauthenticated idle connections time out', async t => {
  const { address } = await fixture(t, { joinTimeoutMs: 30 });
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/collab`);
  await once(ws, 'open');
  assert.equal((await once(ws, 'close'))[0], 1008);
});
