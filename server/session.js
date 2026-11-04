'use strict';
const { randomUUID, timingSafeEqual } = require('node:crypto');

const MAX_TEXT = 50000;
function text(value, max, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
}
function sameSecret(actual, expected) {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The hub is synchronous: a revision check and its update cannot interleave.
// This deliberately uses optimistic concurrency, not OT or a CRDT.
class SessionHub {
  constructor(roomTokens) {
    if (!roomTokens || typeof roomTokens !== 'object' || Array.isArray(roomTokens)) throw new Error('Expected room/token map');
    this.rooms = new Map();
    for (const [name, token] of Object.entries(roomTokens)) {
      if (!text(name, 64) || !text(token, 256) || token.length < 12) throw new Error('Room tokens must contain at least 12 characters');
      this.rooms.set(name, {
        token, epoch: randomUUID(), members: new Map(), chat: [],
        code: { revision: 0, text: '' }, notes: { revision: 0, text: '' }
      });
    }
    if (!this.rooms.size || this.rooms.size > 32) throw new Error('Configure between 1 and 32 rooms');
  }
  connect(send) { return { id: randomUUID(), send, room: null, name: '' }; }
  snapshot(room) {
    return { epoch: room.epoch, code: { ...room.code }, notes: { ...room.notes }, chat: [...room.chat] };
  }
  broadcast(room, message) { for (const member of room.members.values()) member.send(message); }
  presence(room) {
    this.broadcast(room, { type: 'presence', members: [...room.members.values()].map(m => ({ id: m.id, name: m.name })) });
  }
  receive(peer, data) {
    const error = code => peer.send({ type: 'error', code });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return error('invalid_message');
    if (!peer.room) {
      if (data.type !== 'join') return error('join_required');
      const room = this.rooms.get(data.room);
      if (!room || !text(data.token, 256) || !sameSecret(data.token, room.token)) return error('unauthorized');
      if (!text(data.name, 40)) return error('invalid_name');
      if (room.members.size >= 20) return error('room_full');
      peer.room = room;
      peer.name = data.name.trim();
      room.members.set(peer.id, peer);
      peer.send({ type: 'welcome', id: peer.id, ...this.snapshot(room) });
      return this.presence(room);
    }
    const room = peer.room;
    if (data.type === 'sync') return peer.send({ type: 'snapshot', ...this.snapshot(room) });
    if (data.type === 'publish') {
      if (!['code', 'notes'].includes(data.document) || !text(data.text, MAX_TEXT, true) ||
          !Number.isSafeInteger(data.baseRevision) || data.baseRevision < 0 || !text(data.requestId, 64)) return error('invalid_edit');
      const document = room[data.document];
      if (data.epoch !== room.epoch || data.baseRevision !== document.revision) {
        return peer.send({ type: 'conflict', requestId: data.requestId, document: data.document, epoch: room.epoch, ...document });
      }
      document.text = data.text;
      document.revision += 1;
      return this.broadcast(room, {
        type: 'document', document: data.document, epoch: room.epoch, ...document,
        senderId: peer.id, requestId: data.requestId
      });
    }
    if (data.type === 'chat') {
      if (!text(data.text, 2000)) return error('invalid_chat');
      const message = { type: 'chat', id: randomUUID(), senderId: peer.id, name: peer.name, text: data.text, timestamp: Date.now() };
      room.chat.push(message);
      if (room.chat.length > 100) room.chat.shift();
      return this.broadcast(room, message);
    }
    if (data.type === 'cursor') {
      if (data.document !== 'code' || !Number.isSafeInteger(data.offset) || data.offset < 0 ||
          data.offset > room.code.text.length || data.revision !== room.code.revision || data.epoch !== room.epoch) return error('invalid_cursor');
      return this.broadcast(room, { type: 'cursor', document: 'code', senderId: peer.id, name: peer.name,
        offset: data.offset, revision: room.code.revision, epoch: room.epoch });
    }
    return error('unknown_type');
  }
  disconnect(peer) {
    if (!peer.room) return;
    const room = peer.room;
    room.members.delete(peer.id);
    peer.room = null;
    this.broadcast(room, { type: 'left', id: peer.id });
    this.presence(room);
  }
}
module.exports = { SessionHub, MAX_TEXT };
