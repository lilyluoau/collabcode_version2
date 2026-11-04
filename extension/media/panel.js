'use strict';
const vscode = acquireVsCodeApi();
const el = id => document.getElementById(id);
let baseText = '', revision = 0, epoch = null, pending = null;
function send(message) { vscode.postMessage(message); }
function status(text) { el('status').textContent = text; }
function version() { el('notes-version').textContent = `· v${revision}`; }
function chat(message) {
  const item = document.createElement('li');
  const author = document.createElement('strong');
  author.textContent = `${message.name}: `;
  item.append(author, document.createTextNode(message.text));
  el('chat').append(item);
  while (el('chat').children.length > 100) el('chat').firstElementChild.remove();
  item.scrollIntoView({ block: 'nearest' });
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'init') {
    el('room').textContent = `${message.room} · ${message.name}`;
    epoch = message.epoch;
    baseText = el('notes').value = message.notes.text;
    revision = message.notes.revision;
    el('chat').replaceChildren();
    message.chat.forEach(chat);
    version();
  }
  if (message.type === 'notes') {
    const dirty = el('notes').value !== baseText;
    if (message.force) {
      if (dirty) { el('backup').value = el('notes').value; el('backup-section').hidden = false; }
      el('notes').value = baseText = message.text;
      revision = message.revision; epoch = message.epoch; pending = null;
    } else if (message.own) {
      baseText = message.text; revision = message.revision; epoch = message.epoch; pending = null;
      status('Notes published');
    } else if (!dirty && !pending) {
      el('notes').value = baseText = message.text;
      revision = message.revision; epoch = message.epoch;
    } else status('Notes changed remotely. Your draft is preserved; load latest before publishing.');
    version();
  }
  if (message.type === 'chat') chat(message);
  if (message.type === 'presence') el('people').textContent = message.members.map(m => m.name).join(' · ');
  if (message.type === 'status') status(message.text);
  if (message.type === 'conflict') { if (message.document === 'notes') pending = null; }
  if (message.type === 'error') { pending = null; status(message.code); }
});
el('publish').addEventListener('click', () => send({ type: 'publish' }));
el('sync').addEventListener('click', () => send({ type: 'sync' }));
el('save-notes').addEventListener('click', () => {
  if (pending) { status('Waiting for the notes publish response'); return; }
  pending = { text: el('notes').value };
  send({ type: 'notes', text: pending.text, baseRevision: revision, epoch });
});
el('load-notes').addEventListener('click', () => {
  if (pending) { status('Waiting for the notes publish response'); return; }
  send({ type: 'loadNotes' });
});
el('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = el('message').value.trim();
  if (text) { send({ type: 'chat', text }); el('message').value = ''; }
});
send({ type: 'ready' });
