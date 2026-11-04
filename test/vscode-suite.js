'use strict';
// Run with VS Code's --extensionDevelopmentPath and --extensionTestsPath flags.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const vscode = require('vscode');
const WebSocket = require('ws');
const { createServer } = require('../server');
const { CollaborationSession } = require('../extension/extension');

async function eventually(predicate, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  const checks = [];
  const token = 'vscode-test-room-token';
  const app = createServer({ roomTokens: { demo: token } });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}/collab`;
  const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../extension')) };
  const session = new CollaborationSession(context);
  let remote;
  try {
    await session.join({ url, room: 'demo', token, name: 'Local test' });
    assert.equal(session.ready, true);
    checks.push('Extension joined room and opened a shared untitled document');
    remote = new WebSocket(url);
    const messages = [];
    remote.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await once(remote, 'open');
    remote.send(JSON.stringify({ type: 'join', room: 'demo', token, name: 'Remote test' }));
    await eventually(() => messages.some(m => m.type === 'welcome'), 'remote welcome');
    const welcome = messages.find(m => m.type === 'welcome');
    remote.send(JSON.stringify({ type: 'publish', document: 'code', epoch: welcome.epoch, baseRevision: 0, text: 'const answer = 42;\n', requestId: 'first' }));
    await eventually(() => session.document.getText() === 'const answer = 42;\n', 'remote document applied');
    checks.push('Remote publish applied to the real VS Code document');
    remote.send(JSON.stringify({ type: 'cursor', document: 'code', epoch: welcome.epoch, revision: 1, offset: 6 }));
    await eventually(() => session.cursors.has(welcome.id), 'remote cursor decoration');
    assert.equal(session.cursors.get(welcome.id).offset, 6);
    checks.push('Remote cursor creates a decoration at the expected shared-document offset');
    const originalListeners = session.disposables.length;
    const unrelated = await vscode.workspace.openTextDocument({ content: 'unrelated file' });
    await vscode.window.showTextDocument(unrelated);
    await vscode.window.showTextDocument(session.document, vscode.ViewColumn.One);
    assert.equal(session.disposables.length, originalListeners);
    checks.push('Switching editors does not register duplicate session listeners');
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(new vscode.Position(0, 2), new vscode.Position(0, 2));
    await eventually(() => messages.some(m => m.type === 'cursor' && m.senderId === session.id && m.offset === 2), 'outbound cursor');
    checks.push('Real editor selection event sends versioned cursor to the remote socket');
    const change = new vscode.WorkspaceEdit();
    change.insert(session.document.uri, new vscode.Position(0, 0), '// local draft\n');
    assert.equal(await vscode.workspace.applyEdit(change), true);
    const draft = session.document.getText();
    remote.send(JSON.stringify({ type: 'publish', document: 'code', epoch: welcome.epoch, baseRevision: 1, text: 'remote replacement', requestId: 'second' }));
    await eventually(() => session.code.latest.revision === 2, 'remote conflict');
    assert.equal(session.document.getText(), draft);
    session.publish();
    await eventually(() => session.code.pending === null, 'stale publish rejected');
    assert.equal(session.document.getText(), draft);
    checks.push('Concurrent remote update and stale publish preserve the local draft');
    await session.loadLatest();
    assert.equal(session.document.getText(), 'remote replacement');
    assert.ok(vscode.workspace.textDocuments.some(d => d !== session.document && d.getText() === draft));
    checks.push('Load latest creates a separate draft backup before replacing text');
    remote.close();
    await eventually(() => app.hub.rooms.get('demo').members.size === 1, 'remote leave');
    session.dispose();
    await eventually(() => app.hub.rooms.get('demo').members.size === 0, 'local leave');
    assert.equal(session.disposables.length, 0);
    assert.equal(session.cursors.size, 0);
    checks.push('Dispose clears listeners, decorations and server presence');
    console.log(`COLLABCODE_HOST_TEST_PASS ${checks.length} checks`);
    if (process.env.COLLAB_TEST_REPORT) fs.writeFileSync(process.env.COLLAB_TEST_REPORT, JSON.stringify({ passed: true, checks }, null, 2));
  } catch (error) {
    if (process.env.COLLAB_TEST_REPORT) fs.writeFileSync(process.env.COLLAB_TEST_REPORT, JSON.stringify({ passed: false, checks, error: error.stack }, null, 2));
    throw error;
  } finally {
    remote?.terminate();
    session.dispose();
    await app.close();
  }
}
module.exports = { run };
