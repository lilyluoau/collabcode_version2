'use strict';

// Track the server revision separately from the local draft. Remote updates do
// not silently erase local edits; accepting a newer base requires explicit load.
class DocumentState {
  constructor() { this.reset(); }
  reset() {
    this.epoch = null;
    this.revision = 0;
    this.baseText = '';
    this.latest = null;
    this.pending = null;
  }
  initialize(epoch, state) {
    this.epoch = epoch;
    this.revision = state.revision;
    this.baseText = state.text;
    this.latest = { epoch, ...state };
    this.pending = null;
  }
  receive(message, localText, selfId) {
    this.latest = { epoch: message.epoch, revision: message.revision, text: message.text };
    const ownAck = this.pending && message.senderId === selfId && message.requestId === this.pending.requestId;
    if (ownAck) {
      this.epoch = message.epoch;
      this.revision = message.revision;
      this.baseText = message.text;
      this.pending = null;
      return { apply: false, conflict: false };
    }
    if (!this.pending && localText === this.baseText) {
      this.initialize(message.epoch, message);
      return { apply: true, conflict: false };
    }
    return { apply: false, conflict: true };
  }
  request(text, requestId, document) {
    if (this.pending) throw new Error('Wait for the previous publish response');
    const request = { type: 'publish', document, epoch: this.epoch, baseRevision: this.revision, text, requestId };
    this.pending = request;
    return request;
  }
}
module.exports = { DocumentState };
