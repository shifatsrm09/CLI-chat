<h1 align="center">CLI Chat</h1>

<p align="center">
  <strong>Terminal-native real-time messenger and instant edge file sharing.</strong>
</p>

<p align="center">
  Lightweight room chat, private whispers, background auto-sync, and high-speed broadcast file transfers.<br>
  Seamlessly connects native terminal CLI clients and web browser users on <a href="https://chat.cfat.site">chat.cfat.site</a> via Cloudflare edge relay.
</p>

<p align="center">
  <img alt="Version 2.1.0" src="https://img.shields.io/badge/version-2.1.0-5865F2">
  <img alt="Node.js 18+" src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white">
  <img alt="GUI Win32 C++" src="https://img.shields.io/badge/GUI-Win32%20C%2B%2B-00599C?logo=cplusplus&logoColor=white">
  <img alt="Windows & Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078D4">
  <img alt="Cloudflare Edge" src="https://img.shields.io/badge/relay-Cloudflare%20Edge-F38020?logo=cloudflare&logoColor=white">
</p>

<p align="center">
  <a href="https://github.com/shifatsrm09/CLI-chat/releases/latest/download/gui.exe" aria-label="Download CLI Chat GUI for Windows">
    <img src="resources/download-button.svg" alt="Download GUI.exe" width="310" height="49">
  </a>
</p>

<p align="center">
  <a href="https://github.com/shifatsrm09/CLI-chat/releases/latest">All Releases &amp; Binaries</a>
  · <a href="#features">Features</a>
  · <a href="#quick-start">Quick Start</a>
  · <a href="#gui--tray-mode">GUI &amp; Tray</a>
  · <a href="#commands">Commands</a>
</p>

<br>

## Features

- **Cross-Platform Interop:** Chat between command-line terminals and web browsers on [chat.cfat.site](https://chat.cfat.site) with zero configuration.
- **High-Speed File Sharing (`/send`):** 16 KB chunked streaming, Deflate compression, and automatic packet drop recovery (`file_request_chunks`). Broadcasts to all room participants simultaneously.
- **Target File Auto-Sync (`/target`):** Watches a local file for changes and auto-transmits the update to the room whenever you save in your editor.
- **Close-to-Tray Native Host (`gui.exe`):** Native Windows C++ host that intercepts the window close button (`X` or Alt+F4) and minimizes to the System Tray, keeping transfers active in the background.
- **Private Whispers (`/w`):** Direct 1-to-1 targeted messaging within any room.
- **Dual Backend Support:** Connect via Cloudflare Edge Worker (`api.cfat.site`) or Syncplay TLS server (`syncplay.pl:8995`).
- **Stealth Mode (`-s`):** Strips ANSI formatting for minimal or low-profile terminal use.

---

## Quick Start

### Standalone Executables (No Node.js Required)

Grab the latest standalone binary from [GitHub Releases](https://github.com/shifatsrm09/CLI-chat/releases/latest):

```powershell
# Windows Mini GUI with System Tray support
.\gui.exe

# Windows standalone terminal client
.\client-win.exe
# or dev client
.\dev.exe

# Linux standalone terminal client
chmod +x client && ./client
```

### Run from Source (Node.js)

```powershell
npm install

# Start the interactive client
npm start

# Or run the dev client directly
npm run dev

# Or launch the native GUI host
npm run gui
```

Non-interactive startup with command-line flags:

```powershell
node client.js --server web_server --user alice --room 6767
```

---

## GUI & Tray Mode

`gui.exe` provides a native Win32 host wrapper for the terminal:

- **Close to Tray:** Clicking the **X** button hides the console window into the Windows System Tray while keeping WebSocket connections and file transfers alive.
- **Restore:** Double-click the tray icon to restore the terminal window instantly.
- **Tray Menu:** Right-click the tray icon for **Open Terminal**, **Hide to Tray**, and **Exit cli-chat**.

---

## Commands

| Command | Description |
|:---|:---|
| `/help` | Show available commands |
| `/list` | List online users in the room |
| `/room [name]` | Display active room or switch to a new room |
| `/send <path>` | Send a file to everyone in the room |
| `/target <path>` | Watch a file and auto-send whenever saved |
| `/target off` | Stop watching the target file |
| `/w <user> <msg>` | Send a private whisper message |
| `/ls` | List files in current directory |
| `/dir` | Print current working directory |
| `/quit` | Disconnect and exit |

---

## Currently Supported Platforms

| Platform | Executable | Status |
|:---|:---|:---|
| Windows x64 (GUI + Tray) | `gui.exe` | ✅ Available |
| Windows x64 (CLI) | `client-win.exe`, `dev.exe` | ✅ Available |
| Linux x64 (CLI) | `client`, `dev-linux` | ✅ Available |
| Web Browser | [chat.cfat.site](https://chat.cfat.site) | ✅ Live |
