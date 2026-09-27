# CLI Chat

```
tinyurl.com/cli-chat0
```

A **terminal-based real-time chat and file sharing tool** designed for developers Team and university lab environments.

The application runs entirely in the **command line** and allows users to exchange messages and files (~100mb) instantly.

The server is hosted on Render and Two ngrok server (Mirpur,Gazipur) for personal usecase.

---
## Setup and run

Use Node.js 24 (includes npm).

```powershell
npm ci
# For a fresh clone, copy the example if .env does not already exist:
Copy-Item .env.example .env
```

`npm start` and `npm run client` automatically load `.env` if present.
The example uses `PORT=8081`; without a setting, the default is 8080. No API key is required.
Keep `.env` private; it is excluded from Git.

To run locally, open two terminals in the project folder:

```powershell
# Terminal 1: leave the server running
npm start
```

```powershell
# Terminal 2: launch the chat client
npm run client
```

Use the arrow keys to select **Localhost**, press Enter, and enter a username.
Open another client terminal with a different username to chat locally.
The Localhost option uses the same `PORT` from `.env` as the server.
If the port is already in use, choose a free port in `.env` and restart both.

To connect to a hosted server, run `npm run client` and select a hosted option
instead. Availability depends on that server; no local server is needed.

Type `/help` for commands or `/quit` to exit the client. Press Ctrl+C in the
server terminal to stop the server.

The `build:*` scripts package standalone executables and require the optional
`pkg` tool. It is not needed to run the app with Node.js.
