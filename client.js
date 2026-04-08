/**
* cli-chat — Client (Dual TEXT fixed)
* Terminal chat + chunked file/folder transfer.
*
* Commands:
*   /help               — show this list
*   /list               — show online users
*   /ls                 — list contents of the current directory
*   /dir                — show current working directory
*   /send <path>        — offer a file or folder to the room
*   /w <user> <msg>     — private message
*   /quit               — disconnect and exit
*/

"use strict";

const WebSocket  = require("ws");
const readline   = require("readline");
const fs         = require("fs");
const path       = require("path");

/* ─── Config ────────────────────────────────────────────────────── */

const SERVERS = [
   { name: "Render",     url: "wss://cli-chat-ic6w.onrender.com" },
   { name: "Mirpur",     url: "wss://unpurely-heptarchic-corine.ngrok-free.dev" },
   { name: "Gazipur",    url: "wss://unmensurable-shemika-unbronzed.ngrok-free.dev" },
   { name: "Localhost",  url: "ws://localhost:8080" },
];
const CHUNK_SIZE   = 256 * 1024;   // 256 KB per chunk
const MAX_BACKOFF  = 30_000;       // max reconnect delay (ms)
const CONNECT_MAX      = 97;
const CONNECT_DURATION = 70000;
const CONNECT_STEP     = CONNECT_DURATION / CONNECT_MAX;
const CONNECT_GRACE_MS = 10_000;

/* ─── ANSI colours (no dependencies) ───────────────────────────── */

const c = {
   reset:   "\x1b[0m",
   bold:    "\x1b[1m",
   dim:     "\x1b[2m",
   red:     "\x1b[31m",
   green:   "\x1b[32m",
   yellow:  "\x1b[33m",
   blue:    "\x1b[34m",
   magenta: "\x1b[35m",
   cyan:    "\x1b[36m",
   gray:    "\x1b[90m",
};

/* ─── State ─────────────────────────────────────────────────────── */

let ws;
let username;
let selectedServer = SERVERS[0];
let reconnectDelay = 1000;
let quitting       = false;
let rl;
let connectTimer = null;
let connectProgress = 0;
let connectionAttempt = null;

/** Outgoing transfer waiting for accept. { buffer, filename, kind, originalName } */
let outgoingFile = null;

/** Incoming transfer being reassembled. { filename, size, kind, originalName, chunks: Buffer[] } */
let incomingFile = null;

/* ─── Boot: select server, ask username, then connect ──────────── */

(async function boot() {
   showHeader();

   try {
       selectedServer = await selectServer();
   } catch {
       process.exit(1);
   }

   console.log(
       `${c.gray}Selected server:${c.reset} ${c.bold}${selectedServer.name}${c.reset} ${c.gray}(${selectedServer.url})${c.reset}`
   );

   askUsernameAndConnect();
})();

function showHeader() {
   console.clear();
   console.log(
       `\n${c.bold}${c.cyan}  cli-chat${c.reset}  ${c.gray}terminal messenger${c.reset}\n` +
       `${c.gray}  Type /help for available commands${c.reset}\n`
   );
}

function askUsernameAndConnect() {
   const loginRl = readline.createInterface({
       input: process.stdin,
       output: process.stdout,
   });

   loginRl.question(`${c.bold}Username: ${c.reset}`, (name) => {
       loginRl.close();

       username = name.trim();
       if (!username) {
           console.log(`${c.red}Username cannot be empty.${c.reset}`);
           process.exit(1);
       }

       startChat();
   });
}

/* ─── Server selection ──────────────────────────────────────────── */

function selectServer() {
   return new Promise((resolve, reject) => {
       const options = SERVERS;
       let index = 0;

       const renderMenu = () => {
           console.clear();
           console.log(
               `\n${c.bold}${c.cyan}  cli-chat${c.reset}  ${c.gray}terminal messenger${c.reset}\n` +
               `${c.gray}  Select a server with arrow keys and press Enter${c.reset}\n`
           );

           options.forEach((server, i) => {
               const pointer = i === index ? `${c.green}❯${c.reset}` : " ";
               const label = i === index ? `${c.bold}${server.name}${c.reset}` : server.name;
               console.log(` ${pointer} ${label} ${c.gray}- ${server.url}${c.reset}`);
           });
       };

       const cleanup = () => {
           process.stdin.off("keypress", onKeypress);
           if (process.stdin.isTTY) {
               process.stdin.setRawMode(false);
           }
           process.stdin.pause();
       };

       const onKeypress = (_, key) => {
           if (!key) return;

           if (key.ctrl && key.name === "c") {
               cleanup();
               reject(new Error("cancelled"));
               return;
           }

           if (key.name === "up") {
               index = (index - 1 + options.length) % options.length;
               renderMenu();
               return;
           }

           if (key.name === "down") {
               index = (index + 1) % options.length;
               renderMenu();
               return;
           }

           if (key.name === "return") {
               const choice = options[index];
               cleanup();
               console.clear();
               resolve(choice);
           }
       };

       readline.emitKeypressEvents(process.stdin);
       if (process.stdin.isTTY) {
           process.stdin.setRawMode(true);
       }
       process.stdin.resume();
       process.stdin.on("keypress", onKeypress);
       renderMenu();
   });
}

/* ─── Chat readline + connection ───────────────────────────────── */

function startChat() {
   rl = readline.createInterface({
       input: process.stdin,
       output: process.stdout,
       prompt: `${c.bold}${c.green}${username}${c.reset}: `,
   });

   rl.on("line", handleInput);

   connect(false);
}

function promptInput(preserveCursor = false) {
   if (!rl) return;
   rl.prompt(preserveCursor);
}

function connect(isReconnect = false) {
   cleanupConnectionAttempt();

   const attempt = {
       completed: false,
       failed: false,
       server: selectedServer,
       socket: null,
       graceTimer: null,
       statusTimer: null,
       retryTimer: null,
       coldStart: false,
       reconnect: isReconnect,
   };
   connectionAttempt = attempt;

   startProgressBar();
   tryConnectAttempt(attempt);
}

function tryConnectAttempt(attempt) {
   if (connectionAttempt !== attempt || attempt.completed || attempt.failed || quitting) return;

   const socket = new WebSocket(attempt.server.url);
   attempt.socket = socket;
   ws = socket;

   socket.on("open", () => {
       if (connectionAttempt !== attempt || attempt.completed || attempt.failed) return;
       attempt.completed = true;
       clearConnectionTimers(attempt);
       finishProgressBar();
       reconnectDelay = 1000;

       socket.send(JSON.stringify({ type: "join", username }));
       promptInput();
   });

   socket.on("message", handleMessage);

   socket.on("close", () => {
       if (connectionAttempt !== attempt || attempt.completed || attempt.failed || quitting) return;
       handleAttemptRetry(attempt);
   });

   socket.on("error", () => {
       if (connectionAttempt !== attempt || attempt.completed || attempt.failed || quitting) return;
       handleAttemptRetry(attempt);
   });
}

function handleAttemptRetry(attempt) {
   if (attempt.completed || attempt.failed || connectionAttempt !== attempt) return;

   if (!attempt.coldStart) {
       startColdStartWait(attempt, attempt.reconnect);
   }

   if (attempt.retryTimer) return;

   attempt.retryTimer = setTimeout(() => {
       attempt.retryTimer = null;
       if (connectionAttempt !== attempt || attempt.completed || attempt.failed || quitting) return;
       tryConnectAttempt(attempt);
   }, 1500);
}

function startColdStartWait(attempt, isReconnect) {
   if (attempt.coldStart || attempt.completed || attempt.failed) return;
   attempt.coldStart = true;

   attempt.statusTimer = setTimeout(() => {
       if (connectionAttempt !== attempt || attempt.completed || attempt.failed) return;
       clearProgress();
       console.log(`${c.yellow}Server unavailable, waiting for cold start...${c.reset}`);
   }, 1200);

   attempt.graceTimer = setTimeout(() => {
       if (connectionAttempt !== attempt || attempt.completed || attempt.failed) return;
       if (isReconnect) {
           handleReconnectFailure(attempt.server.name);
           return;
       }
       failInitialConnection(attempt, `Connection to ${attempt.server.name} failed.`);
   }, CONNECT_DURATION + CONNECT_GRACE_MS);
}

function clearConnectionTimers(attempt) {
   if (attempt?.graceTimer) {
       clearTimeout(attempt.graceTimer);
       attempt.graceTimer = null;
   }
   if (attempt?.statusTimer) {
       clearTimeout(attempt.statusTimer);
       attempt.statusTimer = null;
   }
   if (attempt?.retryTimer) {
       clearTimeout(attempt.retryTimer);
       attempt.retryTimer = null;
   }
}

function cleanupConnectionAttempt() {
   if (!connectionAttempt) return;
   clearConnectionTimers(connectionAttempt);
   if (connectionAttempt.socket) {
       connectionAttempt.socket.removeAllListeners("open");
       connectionAttempt.socket.removeAllListeners("message");
       connectionAttempt.socket.removeAllListeners("close");
       connectionAttempt.socket.removeAllListeners("error");
       try { connectionAttempt.socket.close(); } catch {}
   }
   connectionAttempt = null;
}

/* ─── Input handler ─────────────────────────────────────────────── */

function handleInput(line) {
   const input = line.trim();
   if (!input) { promptInput(); return; }

   if (input === "/quit" || input === "/exit") {
       quitting = true;
       print(`${c.gray}Goodbye.${c.reset}`);
       if (ws) ws.close();
       rl.close();
       process.exit(0);
   }

   if (input === "/help") {
       print(
           `\n${c.bold}Commands:${c.reset}\n` +
           `  ${c.cyan}/list${c.reset}              — who is online\n` +
           `  ${c.cyan}/ls${c.reset}                — list files/folders in current directory\n` +
           `  ${c.cyan}/dir${c.reset}               — show current working directory\n` +
           `  ${c.cyan}/send <path>${c.reset}       — offer a file or folder to the room\n` +
           `  ${c.cyan}/w <user> <msg>${c.reset}    — private (whisper) message\n` +
           `  ${c.cyan}/quit${c.reset}              — disconnect and exit\n`
       );
       promptInput();
       return;
   }

   if (input === "/list") {
       ws.send(JSON.stringify({ type: "list" }));
       promptInput();
       return;
   }

   if (input === "/ls") {
       listCurrentDirectory();
       return;
   }

   if (input === "/dir") {
       showCurrentDirectory();
       return;
   }

   if (input.startsWith("/send ")) {
       const filepath = input.slice(6).trim();
       sendFile(filepath);
       return;
   }

   if (input.startsWith("/w ")) {
       const parts   = input.slice(3).trim().split(" ");
       const to      = parts.shift();
       const content = parts.join(" ");
       if (!to || !content) {
           print(`${c.red}Usage: /w <username> <message>${c.reset}`);
           return;
       }
       ws.send(JSON.stringify({ type: "whisper", to, content }));
       promptInput();
       return;
   }

   if (input.startsWith("/")) {
       print(`${c.red}Unknown command. Type /help for help.${c.reset}`);
       return;
   }

   ws.send(JSON.stringify({ type: "message", from: username, content: input }));
   promptInput();
}

/* ─── Incoming message handler ──────────────────────────────────── */

function handleMessage(raw) {
   let msg;
   try {
       msg = JSON.parse(raw.toString());
   } catch {
       return;
   }

   switch (msg.type) {
       case "message":
           if (msg.from !== username) {
               print(`${c.bold}${c.blue}${msg.from}${c.reset}: ${msg.content}`);
           }
           break;

       case "whisper":
           print(`${c.magenta}[PM from ${msg.from}]${c.reset} ${msg.content}`);
           break;

       case "whisper-echo":
           print(`${c.gray}[PM → ${msg.to}] ${msg.content}${c.reset}`);
           break;

       case "system":
           print(`${c.gray}[System] ${msg.content}${c.reset}`);
           break;

       case "error":
           print(`${c.red}[Error] ${msg.content}${c.reset}`);
           break;

       case "user-list":
           print(
               `${c.bold}Online (${msg.users.length}):${c.reset} ` +
               msg.users.map((u) => (u === username ? `${c.green}${u} (you)${c.reset}` : u)).join("  ")
           );
           break;

       case "file-meta": {
           const label = msg.kind === "directory" ? "folder" : "file";
           const shownName = msg.originalName || msg.filename;
           rl.question(
               `\n${c.yellow}${msg.from} wants to send ${c.bold}${shownName}${c.reset}${c.yellow} ` +
               `(${label}, ${humanSize(msg.size)}). Accept? [y/N]: ${c.reset}`,
               (answer) => {
                   if (answer.toLowerCase() === "y") {
                       incomingFile = {
                           filename: msg.filename,
                           size: msg.size,
                           kind: msg.kind || "file",
                           originalName: shownName,
                           chunks: [],
                       };
                       ws.send(JSON.stringify({ type: "file-accept", from: msg.from }));
                       print(`${c.gray}Receiving ${label} ${shownName}…${c.reset}`);
                   } else {
                       ws.send(JSON.stringify({ type: "file-reject", from: msg.from }));
                       promptInput();
                   }
               }
           );
           break;
       }

       case "file-accept":
           print(`${c.green}${msg.by} accepted the file. Sending…${c.reset}`);
           if (outgoingFile) {
               transmitFile(outgoingFile.buffer, outgoingFile.filename);
           }
           break;

       case "file-reject":
           print(`${c.yellow}${msg.by} declined the file.${c.reset}`);
           outgoingFile = null;
           break;

       case "file-chunk":
           if (incomingFile) {
               const chunkBuf = Buffer.from(msg.data, "base64");
               incomingFile.chunks.push(chunkBuf);
               const received = incomingFile.chunks.reduce((s, b) => s + b.length, 0);
               drawProgress("Receiving", received, incomingFile.size);
           }
           break;

       case "file-done":
           if (incomingFile) {
               const full = Buffer.concat(incomingFile.chunks);
               clearProgress();
               try {
                   const savedPath = saveIncomingTransfer(incomingFile, full);
                   const label = incomingFile.kind === "directory" ? "Folder" : "File";
                   print(`${c.green}✓ ${label} saved: ${savedPath} (${humanSize(full.length)})${c.reset}`);
               } catch (err) {
                   print(`${c.red}Failed to save incoming transfer: ${err.message}${c.reset}`);
               }
               incomingFile = null;
           }
           break;

       case "file-cancel":
           if (incomingFile) {
               clearProgress();
               print(`${c.red}Transfer cancelled by ${msg.from}.${c.reset}`);
               incomingFile = null;
           }
           break;
   }

   promptInput(true);
}

/* ─── File/folder sending ───────────────────────────────────────── */

function sendFile(filepath) {
   if (!fs.existsSync(filepath)) {
       print(`${c.red}Path not found: ${filepath}${c.reset}`);
       return;
   }

   const stat = fs.statSync(filepath);

   try {
       if (stat.isDirectory()) {
           sendDirectory(filepath);
           return;
       }

       if (!stat.isFile()) {
           print(`${c.red}Only regular files and folders can be sent.${c.reset}`);
           return;
       }

       const filename = path.basename(filepath);

       if (stat.size > 200 * 1024 * 1024) {
           print(`${c.yellow}Warning: file is ${humanSize(stat.size)}. Large transfers may be slow.${c.reset}`);
       }

       const buffer = fs.readFileSync(filepath);
       outgoingFile = { buffer, filename, kind: "file", originalName: filename };

       ws.send(JSON.stringify({
           type: "file-meta",
           from: username,
           filename,
           originalName: filename,
           kind: "file",
           size: stat.size,
       }));
       print(`${c.gray}Offered file ${filename} (${humanSize(stat.size)}) — waiting for acceptance…${c.reset}`);
   } catch (err) {
       print(`${c.red}Failed to prepare transfer: ${err.message}${c.reset}`);
   }
}

function sendDirectory(dirpath) {
   const folderName = path.basename(path.resolve(dirpath));
   const archiveBuffer = buildDirectoryArchive(dirpath, folderName);
   const archiveName = `${folderName}.clidir`;

   if (archiveBuffer.length > 200 * 1024 * 1024) {
       print(`${c.yellow}Warning: folder archive is ${humanSize(archiveBuffer.length)}. Large transfers may be slow.${c.reset}`);
   }

   outgoingFile = {
       buffer: archiveBuffer,
       filename: archiveName,
       kind: "directory",
       originalName: folderName,
   };

   ws.send(JSON.stringify({
       type: "file-meta",
       from: username,
       filename: archiveName,
       originalName: folderName,
       kind: "directory",
       size: archiveBuffer.length,
   }));
   print(`${c.gray}Offered folder ${folderName} (${humanSize(archiveBuffer.length)}) — waiting for acceptance…${c.reset}`);
}

function buildDirectoryArchive(dirpath, rootName) {
   const files = [];
   collectDirectoryEntries(dirpath, dirpath, files);
   const payload = {
       format: "cli-chat-directory-v1",
       rootName,
       entries: files,
   };
   return Buffer.from(JSON.stringify(payload), "utf8");
}

function collectDirectoryEntries(rootDir, currentDir, files) {
   const entries = fs.readdirSync(currentDir, { withFileTypes: true });
   for (const entry of entries) {
       const fullPath = path.join(currentDir, entry.name);
       const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");

       if (entry.isDirectory()) {
           files.push({ type: "dir", path: relativePath });
           collectDirectoryEntries(rootDir, fullPath, files);
           continue;
       }

       if (entry.isFile()) {
           const content = fs.readFileSync(fullPath).toString("base64");
           files.push({ type: "file", path: relativePath, data: content });
       }
   }
}

function transmitFile(buffer, filename) {
   const total  = buffer.length;
   let   offset = 0;
   let   seq    = 0;

   function sendNext() {
       if (offset >= total) {
           clearProgress();
           ws.send(JSON.stringify({ type: "file-done", filename }));
           print(`${c.green}✓ File sent: ${filename}${c.reset}`);
           outgoingFile = null;
           promptInput(true);
           return;
       }

       const slice = buffer.slice(offset, offset + CHUNK_SIZE);
       ws.send(JSON.stringify({
           type: "file-chunk",
           seq,
           data: slice.toString("base64"),
       }));

       offset += slice.length;
       seq++;
       drawProgress("Sending", offset, total);
       setImmediate(sendNext);
   }

   sendNext();
}

/* ─── Progress bar ──────────────────────────────────────────────── */

const BAR_WIDTH = 24;

function drawProgress(label, done, total) {
   const pct   = total > 0 ? Math.min(1, done / total) : 1;
   const filled = Math.round(pct * BAR_WIDTH);
   const bar   = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
   const pctStr = (pct * 100).toFixed(1).padStart(5);
   process.stdout.write(
       `\r${c.cyan}${label}${c.reset} [${bar}] ${pctStr}%  ${humanSize(done)} / ${humanSize(total)}   `
   );
}

function clearProgress() {
   process.stdout.write("\r" + " ".repeat(72) + "\r");
}

function startProgressBar() {
   stopProgressBar();
   connectProgress = 0;
   process.stdout.write("\n");

   connectTimer = setInterval(() => {
       if (connectProgress < CONNECT_MAX) {
           connectProgress++;
       }

       const filled = Math.floor((connectProgress / 100) * BAR_WIDTH);
       const bar = "=".repeat(filled) + " ".repeat(BAR_WIDTH - filled);

       process.stdout.write(
           `\r${c.gray}Connecting [${bar}] ${connectProgress}%${c.reset}`
       );
   }, CONNECT_STEP);
}

function stopProgressBar() {
   if (connectTimer) {
       clearInterval(connectTimer);
       connectTimer = null;
   }
}

function finishProgressBar() {
   stopProgressBar();
   const bar = "=".repeat(BAR_WIDTH);
   process.stdout.write(
       `\r${c.green}Connected  [${bar}] 100%${c.reset}\n\n`
   );
}

/* ─── Utilities ─────────────────────────────────────────────────── */

function print(text) {
   if (process.stdout.isTTY) {
       readline.clearLine(process.stdout, 0);
       readline.cursorTo(process.stdout, 0);
   }
   console.log(text);
   promptInput(true);
}

function humanSize(bytes) {
   if (bytes < 1024)       return `${bytes} B`;
   if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
   return `${(bytes / 1048576).toFixed(1)} MB`;
}

function showCurrentDirectory() {
   print(`${c.bold}Current directory:${c.reset} ${process.cwd()}`);
}

function listCurrentDirectory() {
   try {
       const cwd = process.cwd();
       const entries = fs.readdirSync(cwd, { withFileTypes: true })
           .sort((a, b) => {
               if (a.isDirectory() && !b.isDirectory()) return -1;
               if (!a.isDirectory() && b.isDirectory()) return 1;
               return a.name.localeCompare(b.name);
           });

       if (entries.length === 0) {
           print(`${c.gray}Current directory is empty: ${cwd}${c.reset}`);
           return;
       }

       const lines = entries.map((entry) => {
           const fullPath = path.join(cwd, entry.name);
           const stat = fs.statSync(fullPath);
           if (entry.isDirectory()) {
               return `  ${c.blue}[DIR]${c.reset}  ${entry.name}`;
           }
           return `  ${c.green}[FILE]${c.reset} ${entry.name} ${c.gray}(${humanSize(stat.size)})${c.reset}`;
       });

       print(
           `${c.bold}Current directory:${c.reset} ${cwd}\n` +
           lines.join("\n")
       );
   } catch (err) {
       print(`${c.red}Failed to list current directory: ${err.message}${c.reset}`);
   }
}

function saveIncomingTransfer(meta, buffer) {
   if (meta.kind === "directory") {
       return restoreDirectoryArchive(meta, buffer);
   }

   const savePath = safeFilename(meta.originalName || meta.filename);
   fs.writeFileSync(savePath, buffer);
   return savePath;
}

function restoreDirectoryArchive(meta, buffer) {
   let payload;
   try {
       payload = JSON.parse(buffer.toString("utf8"));
   } catch {
       throw new Error("received folder payload is corrupted");
   }

   if (payload.format !== "cli-chat-directory-v1" || !Array.isArray(payload.entries)) {
       throw new Error("received folder payload has invalid format");
   }

   const targetRoot = safeFilename(meta.originalName || payload.rootName || "received-folder");
   fs.mkdirSync(targetRoot, { recursive: true });

   for (const entry of payload.entries) {
       const safeRel = sanitizeRelativePath(entry.path);
       const fullPath = path.join(targetRoot, safeRel);

       if (entry.type === "dir") {
           fs.mkdirSync(fullPath, { recursive: true });
           continue;
       }

       if (entry.type === "file") {
           fs.mkdirSync(path.dirname(fullPath), { recursive: true });
           fs.writeFileSync(fullPath, Buffer.from(entry.data || "", "base64"));
       }
   }

   return targetRoot;
}

function sanitizeRelativePath(relPath) {
   const normalized = path.posix.normalize(String(relPath || "")).replace(/^\/+/, "");
   if (!normalized || normalized === ".") return "";
   if (normalized.startsWith("../") || normalized === "..") {
       throw new Error(`unsafe path in folder payload: ${relPath}`);
   }
   return normalized;
}

function safeFilename(name) {
   if (!fs.existsSync(name)) return name;
   const ext  = path.extname(name);
   const base = path.basename(name, ext);
   let   i    = 1;
   while (fs.existsSync(`${base}(${i})${ext}`)) i++;
   return `${base}(${i})${ext}`;
}
