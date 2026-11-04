# CollabCode v2

A personal learning project for practicing WebSockets, concurrent updates, and VS Code extension development. This revisits the CollabCode project we built through GDG at NYU.

The extension connects to a small Node.js server. Each room has one shared document, notes, chat, and collaborator cursors. The server assigns user IDs and keeps rooms separate.

```text
VS Code extension ← WebSocket → Node.js room server ← WebSocket → VS Code extension
```

## Run locally

Requires Node.js 22+ and VS Code 1.85+.

```sh
npm ci
npm --prefix extension ci
npm start
```

The server prints a temporary token for the `demo` room and listens on `127.0.0.1:8787`. Open this folder in VS Code and press **F5**. In the development window, run **CollabCode v2: Join Room** and enter the server URL, room, token, and your name.

To try two clients, open a second development window. Edit the shared untitled document and use **Publish Shared Document**. On the same published version, moving a cursor shows it to the other participant. Chat and notes are in the side panel.

```sh
npm test
npm run check
# Optional: test in your installed VS Code (opens a temporary window)
npm run test:vscode
```

## What changed

- Room isolation and one server-assigned identity per connection.
- Cursors tied to the shared document and its revision; listeners cleaned up when leaving.
- Revision checks reject conflicting publishes and preserve local drafts.
- Room tokens, message limits, heartbeat cleanup, and safe text rendering in the panel.

This is a single-server, in-memory demo. Publishing is explicit; it does not automatically merge simultaneous edits. Rejoin manually after disconnecting and save important drafts locally. Internet hosting would also need TLS and a durable storage/authentication design.
