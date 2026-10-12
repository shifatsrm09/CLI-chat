# CLI Chat

```
tinyurl.com/cli-chat0
```

A **serverless terminal-based real-time chat and file sharing tool** designed for developer teams and university lab environments.

The application runs entirely in the **command line** and uses the **Syncplay protocol (`syncplay.pl:8995`)** with StartTLS encryption to exchange messages and files in shared rooms—requiring **zero backend server hosting**.

---

## Features

- **Serverless Syncplay Backend**: Connects directly to `syncplay.pl:8995` over TLS (`StartTLS`). No local or hosted WebSocket server required.
- **Host or Join Rooms**: Create a room (with a custom name or auto-generated room code) or join an existing room.
- **Auto-Chunked Messaging (>150 chars)**: Automatically splits and reassembles messages and whispers that exceed Syncplay's 150-character chat limit.
- **File Sharing (`/send`)**: Compresses and transfers files directly over the Syncplay room channel.
- **Stealth Mode (`-s`)**: Run `node client.js -s` to disable all terminal colors.

---

## Setup and Run

Requires Node.js (zero external runtime npm dependencies).

```powershell
# Launch the chat client
npm start
# or
npm run client
```

1. Enter your **Username** (up to 16 characters).
2. Choose **Host a room** (enter a room name or press Enter to generate a random room code) or **Join a room** (enter an existing room name).
3. Start chatting!

You can also pass CLI flags directly:

```powershell
node client.js --user alice --room CLI-4821
```

---

## Commands

- `/help` — Show available commands
- `/list` — Show online users in the current room
- `/room [name]` — Show current room or switch to another room
- `/ls` — List files and folders in the current working directory
- `/dir` — Show current working directory
- `/send <path>` — Offer a file to the room
- `/w <user> <msg>` — Send a private (whisper) message
- `/quit` — Disconnect and exit

---

## Building Standalone Executables

The `build:*` scripts package standalone executables and require the optional `pkg` tool:

```powershell
npm run build
```
