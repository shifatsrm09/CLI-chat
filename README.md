# CLI Chat

```
tinyurl.com/cli-chat0
```

A **terminal-based real-time chat and file sharing tool** designed for developer teams, university lab environments, and cross-platform terminal-to-web communication.

The application runs in the **command line** (or as standalone Windows/Linux executables) and offers **two real-time backends**:
1. **`syncplay_server`**: Connects via the Syncplay protocol (`syncplay.pl:8995`) with StartTLS encryption.
2. **`web_server`**: Connects via the CFAT Cloudflare Edge Worker (`api.cfat.site`) with WebSockets, enabling seamless communication between CLI terminals and web browser users on **`chat.cfat.site`**.

---

## Features

- **Dual Backend Selection**:
  - **`syncplay_server`**: Zero server hosting, 150-char auto-chunking, and room hosting/joining.
  - **`web_server`**: Cloudflare Edge Worker (`api.cfat.site`), auto-connects to room **`6767`**, interoperable with web users on `chat.cfat.site`.
- **Cross-Platform File Sharing (`/send`)**: Deflate compression, chunking, recipient acceptance prompts, and real-time progress bars in both Syncplay and Web Server modes.
- **Private Whispers (`/w <user> <msg>`)**: Direct 1-to-1 targeted messaging.
- **Dynamic Rooms (`/room [name]`)**: View your active room or switch rooms on the fly.
- **Stealth Mode (`-s`)**: Run with `-s` to disable all terminal colors.

---

## Setup and Run

### Running with Node.js

```powershell
npm start
# or
npm run client
```

### Running the Mini GUI (Close-to-Tray)

You can launch the native Windows Mini GUI directly:

```powershell
.\gui.exe
# or with flags
.\gui.exe --user alice --room 6767
# or via npm
npm run gui
```

- **Close to Tray**: Clicking the **X** button hides the window into the Windows System Tray while keeping chat and background file transfers running.
- **Restore**: Double-click the tray icon to bring the window back up.
- **Tray Menu**: Right-click the tray icon for **Show**, **Hide**, **Send File...**, and **Exit**.
- **Send File**: Use the `Send File...` button for a native file picker or type `/send <path>`.

1. Choose your backend:
   - `syncplay_server`
   - `web_server`
2. Enter your **Username**.
3. In `syncplay_server` mode, choose to **Host a room** or **Join a room**. In `web_server` mode, it automatically joins room **`6767`**.
4. Start chatting!

### Running Non-Interactively with Flags

```powershell
# Connect via web_server to room 6767
node client.js --server web_server --user alice

# Connect via syncplay_server to a custom room
node client.js --server syncplay_server --user bob --room 9988
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

## Standalone Executables

Pre-compiled binaries can be executed directly without Node.js installed:

- **Windows**: `client-win.exe`
- **Linux**: `./client`

To build executables from source:

```powershell
npm run build:win    # packages client-win.exe
npm run build:linux  # packages client (Linux x64)
```
