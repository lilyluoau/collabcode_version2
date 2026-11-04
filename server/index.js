'use strict';
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionHub } = require('./session');

function createServer({ roomTokens, heartbeatMs = 30000, joinTimeoutMs = 10000, maxConnections = 100 } = {}) {
  const hub = new SessionHub(roomTokens);
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/healthz' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/healthz' ? { status: 'ok' } : { error: 'not_found' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    // Only the extension host connects. Browser-origin connections are rejected.
    if (req.url !== '/collab' || req.headers.origin || wss.clients.size >= maxConnections) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    let tokens = 120, lastRefill = Date.now();
    const peer = hub.connect(message => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) return ws.terminate();
      ws.send(JSON.stringify(message));
    });
    const deadline = setTimeout(() => { if (!peer.room) ws.close(1008, 'Join timeout'); }, joinTimeoutMs);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {}); // close handles cleanup, including oversized payloads.
    ws.on('message', (raw, binary) => {
      const now = Date.now();
      tokens = Math.min(120, tokens + (now - lastRefill) * 0.03);
      lastRefill = now;
      if (tokens < 1) return ws.close(1008, 'Rate limit');
      tokens -= 1;
      if (binary) return ws.close(1003, 'JSON text required');
      let data;
      try { data = JSON.parse(raw.toString()); }
      catch { peer.send({ type: 'error', code: 'invalid_json' }); return; }
      hub.receive(peer, data);
      if (peer.room) clearTimeout(deadline);
    });
    ws.on('close', () => { clearTimeout(deadline); hub.disconnect(peer); });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();
  return {
    server, hub,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise(resolve => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(resolve));
    })
  };
}
if (require.main === module) {
  const token = randomBytes(24).toString('hex');
  const rooms = process.env.COLLAB_ROOMS ? JSON.parse(process.env.COLLAB_ROOMS) : { demo: token };
  const app = createServer({ roomTokens: rooms });
  app.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1').then(address => {
    console.log(`CollabCode server listening on ${address.address}:${address.port}`);
    if (!process.env.COLLAB_ROOMS) console.log(`Local demo room: demo\nOne-session access token: ${token}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; app.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
}
module.exports = { createServer };
