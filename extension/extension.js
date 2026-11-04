'use strict';
const vscode = require('vscode');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const WebSocket = require('ws');
const { DocumentState } = require('./document-state');

class CollaborationSession {
  constructor(context) {
    this.context = context;
    this.code = new DocumentState();
    this.notes = new DocumentState();
    this.socket = null;
    this.document = null;
    this.panel = null;
    this.id = null;
    this.ready = false;
    this.closed = false;
    this.cursors = new Map();
    this.disposables = [];
    this.incoming = Promise.resolve();
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.text = 'CollabCode: connecting';
    this.status.command = 'collabcode.publish';
    this.status.show();
    this.disposables.push(this.status);
    // Exactly one listener per session; editor switches do not add listeners.
    this.disposables.push(vscode.window.onDidChangeTextEditorSelection(e => this.selection(e)));
    this.disposables.push(vscode.window.onDidChangeVisibleTextEditors(() => this.renderCursors()));
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document !== this.document || this.applying) return;
      this.clearCursors();
      this.status.text = 'CollabCode: local draft — Publish to share';
    }));
  }
  send(message) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Not connected. Join the room again; your draft stays open.');
    this.socket.send(JSON.stringify(message));
  }
  notify(text) {
    this.status.text = `CollabCode: ${text}`;
    this.panel?.webview.postMessage({ type: 'status', text });
  }
  async join({ url, room, token, name }) {
    this.room = room;
    this.name = name;
    this.document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: '' });
    await vscode.window.showTextDocument(this.document, vscode.ViewColumn.One);
    if (this.closed) return;
    this.openPanel();
    const socket = this.socket = new WebSocket(url, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10000 });
    const joined = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error('Room join timed out')); socket.terminate(); }, 10000);
      this.joinResolve = () => { clearTimeout(deadline); resolve(); };
      this.joinReject = error => { clearTimeout(deadline); reject(error); };
    });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'join', room, token, name })));
    socket.on('message', raw => {
      // Serialize document writes; applyEdit is asynchronous.
      this.incoming = this.incoming.then(async () => {
        if (!this.closed) await this.message(JSON.parse(raw.toString()));
      }).catch(error => { this.joinReject(error); this.notify(error.message); });
    });
    socket.on('error', () => { this.joinReject(new Error('Connection failed')); this.notify('connection failed'); });
    socket.on('close', () => {
      this.ready = false;
      this.clearCursors();
      this.joinReject(new Error('Connection closed'));
      this.notify('disconnected — draft preserved; Join Room to reconnect');
    });
    await joined;
  }
  openPanel() {
    const panel = this.panel = vscode.window.createWebviewPanel('collabcode', 'CollabCode v2', vscode.ViewColumn.Two, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    });
    const nonce = randomBytes(16).toString('hex');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'));
    panel.webview.html = fs.readFileSync(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.html').fsPath, 'utf8')
      .replaceAll('{{nonce}}', nonce).replaceAll('{{script}}', script.toString())
      .replaceAll('{{style}}', style.toString()).replaceAll('{{source}}', panel.webview.cspSource);
    this.disposables.push(panel.webview.onDidReceiveMessage(message => {
      try {
        if (message.type === 'ready') {
          this.panelReady = true;
          if (this.viewState) {
            panel.webview.postMessage({ ...this.viewState, notes: this.notes.latest, chat: this.chatHistory });
            panel.webview.postMessage({ type: 'presence', members: this.members || [] });
          }
          return;
        }
        if (message.type === 'chat' && typeof message.text === 'string') this.send({ type: 'chat', text: message.text });
        if (message.type === 'notes' && typeof message.text === 'string') {
          if (!this.ready) throw new Error('Join a room first');
          if (this.notes.pending) throw new Error('Wait for the previous notes publish');
          this.notes.pending = { requestId: randomUUID() };
          this.send({ type: 'publish', document: 'notes', text: message.text,
            baseRevision: message.baseRevision, epoch: message.epoch, requestId: this.notes.pending.requestId });
        }
        if (message.type === 'loadNotes') {
          if (this.notes.latest) {
            this.notes.initialize(this.notes.latest.epoch, this.notes.latest);
            panel.webview.postMessage({ type: 'notes', text: this.notes.baseText, revision: this.notes.revision, epoch: this.notes.epoch, force: true });
          }
        }
        if (message.type === 'publish') this.publish();
        if (message.type === 'sync') this.loadLatest().catch(error => this.notify(error.message));
      } catch (error) {
        this.notes.pending = null;
        this.notify(error.message);
        panel.webview.postMessage({ type: 'error', code: error.message });
      }
    }));
    this.disposables.push(panel.onDidDispose(() => this.dispose()));
  }
  async replaceCode(text) {
    if (!this.document || this.document.isClosed) throw new Error('Shared document was closed. Join the room again.');
    this.applying = true;
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, new vscode.Range(this.document.positionAt(0), this.document.positionAt(this.document.getText().length)), text);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not apply shared document');
    } finally { this.applying = false; }
  }
  async message(message) {
    if (message.type === 'welcome') {
      this.id = message.id;
      this.code.initialize(message.epoch, message.code);
      this.notes.initialize(message.epoch, message.notes);
      await this.replaceCode(message.code.text);
      this.ready = true;
      this.chatHistory = [...message.chat];
      this.viewState = { type: 'init', epoch: message.epoch, room: this.room, name: this.name, notes: message.notes, chat: message.chat };
      if (this.panelReady) this.panel?.webview.postMessage(this.viewState);
      this.notify(`joined ${this.room}`);
      this.joinResolve();
      return;
    }
    if (message.type === 'document') {
      const state = message.document === 'code' ? this.code : this.notes;
      if (message.document === 'code') {
        const decision = state.receive(message, this.document.getText(), this.id);
        this.clearCursors();
        if (decision.apply) await this.replaceCode(message.text);
        this.notify(decision.conflict ? 'remote update available — local draft preserved' : `code revision ${state.revision}`);
      } else {
        state.latest = { epoch: message.epoch, revision: message.revision, text: message.text };
        const own = message.senderId === this.id && message.requestId === state.pending?.requestId;
        if (own) state.pending = null;
        this.panel?.webview.postMessage({ type: 'notes', text: message.text, revision: message.revision,
          epoch: message.epoch, own, requestId: message.requestId });
      }
      return;
    }
    if (message.type === 'conflict') {
      const state = message.document === 'code' ? this.code : this.notes;
      state.latest = { epoch: message.epoch, revision: message.revision, text: message.text };
      state.pending = null;
      this.notify('conflict — your draft is preserved; load latest before retrying');
      this.panel?.webview.postMessage({ type: 'conflict', document: message.document });
      return;
    }
    if (message.type === 'cursor') {
      if (message.senderId === this.id || message.epoch !== this.code.epoch || message.revision !== this.code.revision ||
          this.document.getText() !== this.code.baseText) return;
      this.removeCursor(message.senderId);
      const colors = ['#e5a36a', '#72c7b8', '#c7a1ed', '#7eaff5'];
      const color = colors[message.senderId.charCodeAt(0) % colors.length];
      const decoration = vscode.window.createTextEditorDecorationType({ border: `1px solid ${color}`,
        after: { contentText: ` ${message.name}`, color } });
      this.cursors.set(message.senderId, { offset: message.offset, decoration });
      this.renderCursors();
      return;
    }
    if (message.type === 'left') this.removeCursor(message.id);
    if (message.type === 'error') {
      this.code.pending = null;
      this.notes.pending = null;
      if (!this.ready) this.joinReject(new Error(`Join failed: ${message.code}`));
      this.notify(message.code);
      this.panel?.webview.postMessage({ type: 'error', code: message.code });
    }
    if (message.type === 'chat') {
      this.chatHistory.push(message);
      if (this.chatHistory.length > 100) this.chatHistory.shift();
    }
    if (message.type === 'presence') this.members = message.members;
    if (this.panelReady && ['chat', 'presence'].includes(message.type)) this.panel?.webview.postMessage(message);
  }
  publish() {
    if (!this.ready) throw new Error('Join a room first');
    if (!this.document || this.document.isClosed) throw new Error('Shared document closed; join again');
    const content = this.document.getText();
    if (content.length > 50000) throw new Error('Document exceeds 50,000 characters');
    this.send(this.code.request(content, randomUUID(), 'code'));
    this.notify('publishing');
  }
  async loadLatest() {
    if (!this.code.latest || this.code.pending) { this.notify('wait for the publish response'); return; }
    if (!this.document || this.document.isClosed) throw new Error('Shared document closed; join again');
    // Back up a diverged draft to another untitled editor before replacing it.
    if (this.document.getText() !== this.code.baseText) {
      const backup = await vscode.workspace.openTextDocument({ content: this.document.getText(), language: this.document.languageId });
      await vscode.window.showTextDocument(backup, { preview: false, preserveFocus: true });
    }
    const latest = { ...this.code.latest };
    await this.replaceCode(latest.text);
    this.code.initialize(latest.epoch, latest);
    this.clearCursors();
    this.notify(`loaded revision ${latest.revision}; any changed draft backed up`);
    await vscode.window.showTextDocument(this.document, vscode.ViewColumn.One);
  }
  selection(event) {
    if (!this.ready || event.textEditor.document !== this.document || !event.selections.length ||
        this.code.pending || this.document.getText() !== this.code.baseText) return;
    const offset = this.document.offsetAt(event.selections[0].active);
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => {
      if (!this.ready || this.code.pending || this.document?.isClosed || this.document.getText() !== this.code.baseText) return;
      try { this.send({ type: 'cursor', document: 'code', epoch: this.code.epoch, revision: this.code.revision, offset }); }
      catch { /* close handler updates the UI */ }
    }, 60);
  }
  renderCursors() {
    for (const editor of vscode.window.visibleTextEditors) {
      for (const cursor of this.cursors.values()) {
        const ranges = editor.document === this.document ? [new vscode.Range(this.document.positionAt(cursor.offset), this.document.positionAt(cursor.offset))] : [];
        editor.setDecorations(cursor.decoration, ranges);
      }
    }
  }
  removeCursor(id) { this.cursors.get(id)?.decoration.dispose(); this.cursors.delete(id); }
  clearCursors() { for (const id of this.cursors.keys()) this.removeCursor(id); }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.cursorTimer);
    this.socket?.terminate();
    this.clearCursors();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.panel?.dispose();
  }
}

function activate(context) {
  let session = null, joining = false;
  const run = action => async () => { try { await action(); } catch (error) { vscode.window.showErrorMessage(`CollabCode: ${error.message}`); } };
  context.subscriptions.push(vscode.commands.registerCommand('collabcode.join', run(async () => {
    if (joining) return;
    joining = true;
    try {
      const url = await vscode.window.showInputBox({ prompt: 'Server URL', value: 'ws://127.0.0.1:8787/collab',
        validateInput: value => { try { const u = new URL(value); return ['ws:', 'wss:'].includes(u.protocol) && !u.username && !u.password && !u.search && u.pathname === '/collab' ? undefined : 'Use ws://host:port/collab or wss://host/collab'; } catch { return 'Invalid URL'; } } });
      if (!url) return;
      const room = await vscode.window.showInputBox({ prompt: 'Room name', value: 'demo' });
      if (!room) return;
      const token = await vscode.window.showInputBox({ prompt: 'Room access token (kept in memory only)', password: true });
      if (!token) return;
      const name = await vscode.window.showInputBox({ prompt: 'Your display name', validateInput: value => value.trim() && value.length <= 40 ? undefined : 'Use 1–40 characters' });
      if (!name) return;
      session?.dispose();
      session = new CollaborationSession(context);
      try { await session.join({ url, room, token, name }); }
      catch (error) { session.dispose(); throw error; }
    } finally { joining = false; }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('collabcode.publish', run(() => {
    if (!session) throw new Error('Join a room first');
    session.publish();
  })));
  context.subscriptions.push(vscode.commands.registerCommand('collabcode.sync', run(() => session?.loadLatest())));
  context.subscriptions.push(vscode.commands.registerCommand('collabcode.leave', () => { session?.dispose(); session = null; }));
  context.subscriptions.push({ dispose: () => session?.dispose() });
}
module.exports = { activate, CollaborationSession };
