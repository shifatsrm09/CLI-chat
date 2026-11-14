/**
 * cli-chat (dev) — Web-Native Terminal Client
 * Real-time terminal chat, room hosting/joining, whisper messaging,
 * auto-accept file sharing, and target file auto-sync.
 *
 * Connected by default to CFAT Edge Worker relay:
 *   api.cfat.site / chat.cfat.site
 *
 * Commands:
 *   /help               — show command list
 *   /list               — show online users in the room
 *   /room [name]        — show current room or switch room
 *   /ls                 — list files in current directory
 *   /dir                — show current working directory
 *   /send <path>        — offer a file to the room
 *   /target <path>      — watch a file and auto-send whenever updated/saved
 *   /target off         — stop watching target file
 *   /w <user> <msg>     — private (whisper) message
 *   /quit               — disconnect and exit
 */

"use strict";

const readline = require("readline");
const fs       = require("fs");
const path     = require("path");
const zlib     = require("zlib");
const crypto   = require("crypto");

let WebSocketClient = null;
try {
    WebSocketClient = require("ws");
} catch {
    try {
        WebSocketClient = require(path.join(__dirname, "node_modules", "ws"));
    } catch {
        WebSocketClient = globalThis.WebSocket || null;
    }
}

const STEALTH = process.argv.includes("-s");

/* ─── Config ────────────────────────────────────────────────────── */

const CFAT_WS_URL            = getArgValue("--ws-url") || "wss://api.cfat.site/ws";
const CFAT_DEFAULT_ROOM      = "6767";

const MAX_USERNAME_LEN       = 24;
const MAX_ROOM_NAME_LEN      = 35;
const WEB_FILE_SLICE         = 16 * 1024; // 16 KB raw payload per chunk (< 32KB/64KB frame limits)
const WEB_CHUNK_PACE_MS      = 25;        // 25ms pacing (~40 msgs/sec, fast and smooth under 800/5s limit)
const WEB_PING_INTERVAL_MS   = 25_000;    // Cloudflare Worker keepalive ping
const CONNECT_TIMEOUT_MS     = 15_000;
const CONNECT_MAX            = 97;
const CONNECT_DURATION       = 15_000;
const CONNECT_STEP           = CONNECT_DURATION / CONNECT_MAX;
const BAR_WIDTH              = 24;

/* ─── ANSI colours (no dependencies) ───────────────────────────── */

const c = STEALTH
    ? new Proxy({}, { get: () => "" })
    : {
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

let username         = getArgValue("--user") || getArgValue("-u") || "";
let room             = getArgValue("--room") || getArgValue("-r") || "";

// WebSocket handles
let webSocket        = null;
let webPingTimer     = null;

const CLIENT_INSTANCE_ID = "cli-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let usernameTaken    = false;

let connected        = false;
let quitting         = false;
let rl               = null;
let connectTimer     = null;
let connectProgress  = 0;
let connectionAttempt = null;
let reconnectTimer   = null;
let retryCount       = 0;
let pendingListPrint = false;

/** Online users in current room */
const roomUsers = new Set();

/** Outgoing transfers currently sending or recently finished */
const outgoingTransfers       = new Map();
const recentOutgoingTransfers = new Map();
let outgoingFile              = null; // active outgoing transfer for progress bar

/** Incoming transfers being reassembled */
const incomingTransfers       = new Map();
let incomingFile              = null; // active incoming transfer for progress bar

/** Target file auto-send watcher */
let targetFilePath           = null;
let targetWatcher            = null;
let targetDebounceTimer      = null;
let targetLastMtime          = 0;
let targetLastFileHash       = "";
let targetPendingUpdateTimer = null;

/* ─── Boot Flow ─────────────────────────────────────────────────── */

(async function boot() {
    showHeader();

    try {
        if (!username) {
            username = await askQuestion(`${c.bold}Username: ${c.reset}`);
        }
        username = sanitizeUsername(username);
        if (!username) {
            console.log(`${c.red}Username cannot be empty.${c.reset}`);
            process.exit(1);
        }

        if (!room) {
            const roomInput = await askQuestion(
                `${c.bold}Room code ${c.gray}(press Enter for default ${CFAT_DEFAULT_ROOM})${c.reset}${c.bold}: ${c.reset}`
            );
            room = sanitizeRoomName(roomInput) || CFAT_DEFAULT_ROOM;
        } else {
            room = sanitizeRoomName(room);
        }

        console.log(
            `${c.gray}Backend:${c.reset} ${c.bold}web_server${c.reset} ${c.gray}(api.cfat.site / chat.cfat.site)${c.reset} ` +
            `${c.gray}| User:${c.reset} ${c.bold}${username}${c.reset} ` +
            `${c.gray}| Room:${c.reset} ${c.bold}${c.cyan}${room}${c.reset}`
        );
    } catch {
        process.exit(1);
    }

    startChat();
})();

/* ─── Helpers ───────────────────────────────────────────────────── */

function getArgValue(flag) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1];
    }
    const prefix = `${flag}=`;
    const inline = process.argv.find((a) => a.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    return null;
}

function sanitizeUsername(name) {
    return String(name || "").trim().slice(0, MAX_USERNAME_LEN);
}

function sanitizeRoomName(name) {
    return String(name || "").trim().slice(0, MAX_ROOM_NAME_LEN);
}

function showHeader() {
    if (STEALTH) return;
    console.clear();
    console.log(
        `\n${c.bold}${c.cyan}  cli-chat (dev)${c.reset}  ${c.gray}web terminal messenger (chat.cfat.site)${c.reset}\n` +
        `${c.gray}  Direct WebSocket Edge Relay · Type /help for command list${c.reset}\n`
    );
}

function askQuestion(query) {
    return new Promise((resolve) => {
        const queryRl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        queryRl.question(query, (ans) => {
            queryRl.close();
            resolve(ans.trim());
        });
    });
}

/* ─── Chat Readline Lifecycle ──────────────────────────────────── */

function startChat() {
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${c.bold}${c.green}${username}${c.reset}: `,
    });

    rl.on("line", handleInput);
    rl.on("close", () => {
        if (targetWatcher) {
            try { targetWatcher.close(); } catch (_) {}
            targetWatcher = null;
        }
        if (!quitting) {
            quitting = true;
            cleanupConnection();
            process.exit(0);
        }
    });

    connect(false);
}

function updatePrompt() {
    if (!rl) return;
    rl.setPrompt(`${c.bold}${c.green}${username}${c.reset}: `);
}

function promptInput(preserveCursor = false) {
    if (!rl || quitting) return;
    rl.prompt(preserveCursor);
}

/* ─── Connection Management ────────────────────────────────────── */

function connect(isReconnect = false) {
    if (quitting) return;
    cleanupConnection();

    if (!WebSocketClient) {
        print(`${c.red}[Error] WebSocket client module not available. Run: npm install ws${c.reset}`);
        return;
    }

    const attempt = {
        backend: "web_server",
        completed: false,
        failed: false,
        reconnect: isReconnect,
        timeoutTimer: null,
    };
    connectionAttempt = attempt;

    if (!isReconnect) {
        startConnectProgress("Connecting to api.cfat.site…");
    }

    attempt.timeoutTimer = setTimeout(() => {
        if (connectionAttempt !== attempt || attempt.completed || attempt.failed) return;
        attempt.failed = true;
        handleConnectionDrop(attempt, "Connection to api.cfat.site timed out");
    }, CONNECT_TIMEOUT_MS);

    const wsUrl = `${CFAT_WS_URL}?room=${encodeURIComponent(room)}&user=${encodeURIComponent(username)}&clientId=${encodeURIComponent(CLIENT_INSTANCE_ID)}&game=chat`;

    try {
        const ws = new WebSocketClient(wsUrl);
        webSocket = ws;

        ws.on("open", () => {
            if (connectionAttempt !== attempt || attempt.failed) {
                try { ws.close(); } catch (_) {}
                return;
            }

            attempt.completed = true;
            if (attempt.timeoutTimer) {
                clearTimeout(attempt.timeoutTimer);
                attempt.timeoutTimer = null;
            }

            connected = true;
            usernameTaken = false;
            retryCount = 0;
            finishConnectProgress();

            print(
                `${c.green}[System] Connected to api.cfat.site | ` +
                `Room: ${c.bold}${c.cyan}${room}${c.reset}${c.green} | ` +
                `User: ${c.bold}${username}${c.reset}`
            );
            promptInput();

            // Setup keepalive ping
            if (webPingTimer) clearInterval(webPingTimer);
            webPingTimer = setInterval(() => {
                if (webSocket && webSocket.readyState === 1) {
                    try {
                        webSocket.send(JSON.stringify({ type: "ping" }));
                    } catch (_) {}
                }
            }, WEB_PING_INTERVAL_MS);
        });

        ws.on("message", (data) => {
            if (connectionAttempt !== attempt && webSocket !== ws) return;
            handleWebFrame(attempt, data);
        });

        ws.on("close", (code, reason) => {
            if (connectionAttempt === attempt) {
                const textReason = reason ? reason.toString() : `code ${code}`;
                if (code === 4003 || usernameTaken) {
                    finishConnectProgress();
                    cleanupConnection();
                    print(`${c.red}[System] Handle "${username}" is already in use in room ${room}.${c.reset}`);
                    promptRename();
                    return;
                }
                handleConnectionDrop(attempt, textReason);
            }
        });

        ws.on("error", (err) => {
            if (connectionAttempt === attempt) {
                handleConnectionDrop(attempt, err.message);
            }
        });
    } catch (err) {
        handleConnectionDrop(attempt, err.message);
    }
}

function handleWebFrame(attempt, raw) {
    let msg;
    try {
        msg = JSON.parse(raw.toString("utf8"));
    } catch {
        return;
    }

    if (!msg || typeof msg !== "object") return;

    // 1. Room State (initial snapshot)
    if (msg.type === "room_state") {
        roomUsers.clear();
        roomUsers.add(username);
        if (Array.isArray(msg.users)) {
            for (const u of msg.users) {
                const clean = String(u || "").trim();
                if (clean) roomUsers.add(clean);
            }
        }
        if (pendingListPrint) {
            pendingListPrint = false;
            printUserList();
        }
        return;
    }

    // 2. User Joined notification
    if (msg.type === "user_joined") {
        const joinedUser = String(msg.user || "").trim();
        if (joinedUser) {
            roomUsers.add(joinedUser);
            if (joinedUser.toLowerCase() !== username.toLowerCase()) {
                print(`${c.gray}[System] ${joinedUser} joined the room${c.reset}`);
            }
        }
        if (Array.isArray(msg.users)) {
            for (const u of msg.users) {
                const clean = String(u || "").trim();
                if (clean) roomUsers.add(clean);
            }
        }
        return;
    }

    // 3. User Left notification
    if (msg.type === "user_left") {
        const leftUser = String(msg.user || "").trim();
        if (leftUser) {
            roomUsers.delete(leftUser);
            cleanupUserTransfers(leftUser);
            if (leftUser.toLowerCase() !== username.toLowerCase()) {
                print(`${c.gray}[System] ${leftUser} left the room${c.reset}`);
            }
        }
        if (Array.isArray(msg.users)) {
            roomUsers.clear();
            roomUsers.add(username);
            for (const u of msg.users) {
                const clean = String(u || "").trim();
                if (clean) roomUsers.add(clean);
            }
        }
        return;
    }

    // 4. Standard Chat Message
    if (msg.type === "chat") {
        const sender = String(msg.user || "").trim();
        const text   = String(msg.message || "");
        if (!sender || sender.toLowerCase() === username.toLowerCase()) return; // ignore our own echo
        roomUsers.add(sender);
        print(`${c.bold}${c.blue}${sender}${c.reset}: ${text}`);
        return;
    }

    // 5. Pong Keepalive response
    if (msg.type === "pong") {
        return;
    }

    // 6. Action: Whispers and File Transfers
    if (msg.type === "action" || msg.type === "game") {
        handleWebActionPayload(msg);
        return;
    }

    // 7. System notification
    if (msg.type === "system") {
        if (msg.message) {
            print(`${c.yellow}[System] ${msg.message}${c.reset}`);
        }
        return;
    }

    // 8. Server Error
    if (msg.type === "error") {
        if (msg.code === "USERNAME_TAKEN") {
            usernameTaken = true;
        }
        print(`${c.red}[Error] ${msg.error || msg.message || "Server error"}${c.reset}`);
    }
}

function promptRename() {
    usernameTaken = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (!rl) {
        askQuestion(`${c.bold}Enter a different handle: ${c.reset}`).then((ans) => {
            const clean = sanitizeUsername(ans);
            if (clean) {
                username = clean;
                connect();
            } else {
                promptRename();
            }
        });
        return;
    }
    rl.question(`\n${c.bold}Enter a different handle: ${c.reset}`, (ans) => {
        const clean = sanitizeUsername(ans);
        if (clean) {
            username = clean;
            rl.setPrompt(`${c.bold}${c.green}${username}${c.reset}: `);
            connect();
        } else {
            promptRename();
        }
    });
}

function handleWebActionPayload(msg) {
    const sender = String(msg.fromUser || msg.user || "").trim();
    const action = String(msg.action || "");

    switch (action) {
        case "whisper": {
            if (sender && msg.message) {
                if (sender.toLowerCase() === username.toLowerCase()) break;
                print(`${c.magenta}[PM from ${sender}]${c.reset} ${msg.message}`);
            }
            break;
        }

        case "file_offer": {
            const filename   = String(msg.filename || "file").replace(/[/\\]/g, "_");
            const size       = Number(msg.size) || 0;
            const id         = String(msg.id || "");
            const compressed = Boolean(msg.compressed);
            const chunks     = Number(msg.totalChunks) || 0;

            if (!id || !sender || sender.toLowerCase() === username.toLowerCase()) break;

            // Silence auto-sync watcher while downloading this targeted file
            const targetResolved = targetFilePath ? path.resolve(targetFilePath) : null;
            const offerResolved = path.resolve(process.cwd(), safeFilename(filename));
            if (targetResolved && targetResolved === offerResolved) {
                if (targetDebounceTimer) {
                    clearTimeout(targetDebounceTimer);
                    targetDebounceTimer = null;
                }
            }

            const existing = incomingTransfers.get(id);
            if (existing && existing.finalized) break;

            const transfer = {
                backend: "web",
                from: sender,
                id,
                filename,
                size,
                compressed,
                totalChunks: chunks,
                chunks: new Array(Math.max(1, chunks)).fill(null),
                receivedChunks: 0,
                receivedEncodedBytes: 0,
                finalized: false,
                watchdogTimer: null,
                retryCount: 0,
            };
            incomingTransfers.set(id, transfer);
            incomingFile = transfer;

            sendWebAction({ action: "file_accept", to: sender, id });
            print(`${c.yellow}${sender} is sending ${c.bold}${filename}${c.reset}${c.yellow} (${humanSize(size)}) — auto-accepting…${c.reset}`);
            if (size === 0 && chunks === 0) {
                finalizeIncomingTransfer(transfer);
            } else {
                resetIncomingWatchdog(transfer);
            }
            break;
        }

        case "file_accept": {
            const transfer = outgoingTransfers.get(msg.id);
            if (!transfer) break;
            if (sender) transfer.acceptedBy.add(sender);
            if (!transfer.isTransmitting) {
                if (transfer.timer) clearTimeout(transfer.timer);
                transmitWebFile(transfer);
            }
            break;
        }

        case "file_reject": {
            const transfer = outgoingTransfers.get(msg.id);
            if (transfer && sender) {
                transfer.acceptedBy.delete(sender);
            }
            break;
        }

        case "file_request_chunks": {
            const transfer = outgoingTransfers.get(msg.id) || recentOutgoingTransfers.get(msg.id);
            if (!transfer || !sender || !Array.isArray(msg.missing)) break;

            const payload = transfer.payloadBuffer;
            const totalChunks = transfer.totalChunks;
            const missingList = msg.missing.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < totalChunks);
            let mIdx = 0;

            function sendNextRetryChunk() {
                if (!connected || mIdx >= missingList.length) {
                    sendWebAction({
                        action: "file_done",
                        to: sender,
                        id: transfer.id,
                        totalChunks,
                    });
                    return;
                }
                const idx = missingList[mIdx++];
                const start = idx * WEB_FILE_SLICE;
                const slice = payload.subarray(start, start + WEB_FILE_SLICE);
                sendWebAction({
                    action: "file_chunk",
                    to: sender,
                    id: transfer.id,
                    i: idx,
                    index: idx,
                    n: totalChunks,
                    totalChunks,
                    d: slice.toString("base64"),
                });
                setTimeout(sendNextRetryChunk, 15);
            }
            sendNextRetryChunk();
            break;
        }

        case "file_chunk": {
            const transfer = incomingTransfers.get(msg.id);
            if (!transfer || transfer.finalized) break;
            if (sender && transfer.from.toLowerCase() !== sender.toLowerCase()) break;

            const idx = Number(msg.index !== undefined ? msg.index : msg.i);
            const total = Number(msg.totalChunks !== undefined ? msg.totalChunks : msg.n);
            const b64 = String(msg.data !== undefined ? msg.data : (msg.d || ""));

            if (!Number.isInteger(idx) || idx < 0 || idx >= transfer.totalChunks || !b64) break;
            if (transfer.chunks[idx] !== null) break; // duplicate chunk

            const chunkBuf = Buffer.from(b64, "base64");
            transfer.chunks[idx] = chunkBuf;
            transfer.receivedChunks++;
            transfer.receivedEncodedBytes += chunkBuf.length;

            incomingFile = transfer;
            const approxRawReceived = Math.min(
                transfer.size,
                Math.round((transfer.receivedChunks / transfer.totalChunks) * transfer.size)
            );
            drawProgress("Receiving", approxRawReceived, transfer.size);
            resetIncomingWatchdog(transfer);

            if (transfer.receivedChunks >= transfer.totalChunks) {
                finalizeIncomingTransfer(transfer);
            }
            break;
        }

        case "file_done": {
            const transfer = incomingTransfers.get(msg.id);
            if (!transfer || transfer.finalized) break;
            if (sender && transfer.from.toLowerCase() !== sender.toLowerCase()) break;

            if (transfer.receivedChunks >= transfer.totalChunks) {
                finalizeIncomingTransfer(transfer);
            } else {
                requestMissingChunks(transfer);
            }
            break;
        }

        case "file_cancel": {
            const transfer = incomingTransfers.get(msg.id);
            if (transfer && (!sender || transfer.from.toLowerCase() === sender.toLowerCase())) {
                clearProgress();
                if (transfer.watchdogTimer) clearTimeout(transfer.watchdogTimer);
                print(`${c.red}Transfer cancelled by ${sender || "peer"}.${c.reset}`);
                incomingTransfers.delete(msg.id);
                if (incomingFile === transfer) incomingFile = null;
            }
            break;
        }
    }
}

function sendWebAction(payload) {
    if (!connected || !webSocket || webSocket.readyState !== 1) return false;
    try {
        webSocket.send(JSON.stringify({
            type: "action",
            ...payload,
        }));
        return true;
    } catch {
        return false;
    }
}

function handleConnectionDrop(attempt, reason) {
    if (attempt && attempt.timeoutTimer) {
        clearTimeout(attempt.timeoutTimer);
        attempt.timeoutTimer = null;
    }

    if (connectionAttempt === attempt) {
        connectionAttempt = null;
    }

    const wasConnected = connected;
    cleanupConnection();

    if (quitting) return;

    if (wasConnected) {
        print(`${c.yellow}[System] Disconnected (${reason}). Reconnecting…${c.reset}`);
        retryCount = 0;
    } else {
        finishConnectProgress();
        print(`${c.yellow}[System] Connection issue (${reason}). Retrying…${c.reset}`);
    }

    const delay = Math.min(1000 * 2 ** retryCount, 15_000);
    retryCount++;
    reconnectTimer = setTimeout(() => connect(true), delay);
}

function cleanupConnection() {
    connected = false;

    if (webPingTimer) {
        clearInterval(webPingTimer);
        webPingTimer = null;
    }
    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (webSocket) {
        try {
            webSocket.removeAllListeners();
            webSocket.close();
        } catch (_) {}
        webSocket = null;
    }

    clearProgress();
}

/* ─── Input Handler ─────────────────────────────────────────────── */

function handleInput(line) {
    const input = line.trim();
    if (!input) {
        promptInput();
        return;
    }

    if (input === "/quit" || input === "/exit") {
        quitting = true;
        if (targetWatcher) {
            try { targetWatcher.close(); } catch (_) {}
            targetWatcher = null;
        }
        if (outgoingFile?.acceptedBy) {
            sendWebAction({ action: "file_cancel", to: outgoingFile.acceptedBy, id: outgoingFile.id });
        }
        print(`${c.gray}Goodbye.${c.reset}`);
        cleanupConnection();
        rl.close();
        process.exit(0);
    }

    if (input === "/help") {
        print(
            `\n${c.bold}Commands:${c.reset}\n` +
            `  ${c.cyan}/list${c.reset}              — show online users in current room\n` +
            `  ${c.cyan}/room [name]${c.reset}       — show current room or switch room\n` +
            `  ${c.cyan}/ls${c.reset}                — list files in current directory\n` +
            `  ${c.cyan}/dir${c.reset}               — show current working directory\n` +
            `  ${c.cyan}/send <path>${c.reset}       — offer a file to the room\n` +
            `  ${c.cyan}/target <path>${c.reset}     — watch file and auto-send on update/save\n` +
            `  ${c.cyan}/target off${c.reset}        — stop watching target file\n` +
            `  ${c.cyan}/w <user> <msg>${c.reset}    — private (whisper) message\n` +
            `  ${c.cyan}/quit${c.reset}              — disconnect and exit\n`
        );
        return;
    }

    if (input === "/list") {
        if (!connected) {
            print(`${c.red}[Error] Not connected.${c.reset}`);
            return;
        }
        printUserList();
        if (webSocket && webSocket.readyState === 1) {
            try { webSocket.send(JSON.stringify({ type: "get_room_state" })); } catch (_) {}
        }
        return;
    }

    if (input === "/room" || input.startsWith("/room ")) {
        const targetRoom = sanitizeRoomName(input.slice(5));
        if (!targetRoom) {
            print(`${c.bold}Current room:${c.reset} ${c.cyan}${room}${c.reset} ${c.gray}(use /room <name> to switch)${c.reset}`);
            return;
        }
        if (!connected) {
            print(`${c.red}[Error] Not connected.${c.reset}`);
            return;
        }
        room = targetRoom;
        roomUsers.clear();
        roomUsers.add(username);

        print(`${c.gray}[System] Switching to room:${c.reset} ${c.bold}${c.cyan}${room}${c.reset}…`);
        connect(false);
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
        const filepath = input.slice(6).trim().replace(/^["']|["']$/g, "");
        sendFile(filepath);
        return;
    }

    if (input === "/target") {
        if (targetFilePath) {
            print(`${c.bold}Current target file:${c.reset} ${c.cyan}${targetFilePath}${c.reset} ${c.green}(watching)${c.reset}\n${c.gray}Use /target <path> to change, or /target off to stop.${c.reset}`);
        } else {
            print(`${c.bold}Target auto-sync:${c.reset} ${c.gray}none. Usage: /target <filepath> (e.g. /target myfile.txt)${c.reset}`);
        }
        return;
    }

    if (input.startsWith("/target ")) {
        const targetArg = input.slice(8).trim().replace(/^["']|["']$/g, "");
        setTargetFile(targetArg);
        return;
    }

    if (input.startsWith("/w ")) {
        const parts   = input.slice(3).trim().split(" ");
        const to      = parts.shift();
        const content = parts.join(" ").trim();
        if (!to || !content) {
            print(`${c.red}Usage: /w <username> <message>${c.reset}`);
            return;
        }
        if (sendWebAction({ action: "whisper", to, message: content })) {
            print(`${c.gray}[PM → ${to}] ${content}${c.reset}`);
        }
        return;
    }

    if (input.startsWith("/")) {
        print(`${c.red}Unknown command. Type /help for help.${c.reset}`);
        return;
    }

    if (!connected || !webSocket || webSocket.readyState !== 1) {
        print(`${c.red}[Error] Not connected to api.cfat.site.${c.reset}`);
        return;
    }
    webSocket.send(JSON.stringify({ type: "chat", text: input }));
    promptInput();
}

/* ─── Target File Auto-Sync Watcher ────────────────────────────── */

function setTargetFile(filepath) {
    if (!filepath || filepath === "off" || filepath === "clear" || filepath === "stop") {
        if (targetWatcher) {
            try { targetWatcher.close(); } catch (_) {}
            targetWatcher = null;
        }
        if (targetDebounceTimer) {
            clearTimeout(targetDebounceTimer);
            targetDebounceTimer = null;
        }
        targetFilePath = null;
        targetLastMtime = 0;
        print(`${c.yellow}[Target] Auto-sync disabled.${c.reset}`);
        return;
    }

    const resolved = path.resolve(process.cwd(), filepath);

    if (!fs.existsSync(resolved)) {
        print(`${c.red}[Target Error] File not found: ${resolved}${c.reset}`);
        return;
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
        print(`${c.red}[Target Error] Cannot target a directory. Specify a regular file.${c.reset}`);
        return;
    }

    if (targetWatcher) {
        try { targetWatcher.close(); } catch (_) {}
        targetWatcher = null;
    }
    if (targetDebounceTimer) {
        clearTimeout(targetDebounceTimer);
        targetDebounceTimer = null;
    }

    targetFilePath = resolved;
    targetLastMtime = stat.mtimeMs;

    try {
        targetWatcher = fs.watch(targetFilePath, (eventType) => {
            if (eventType === "change" || eventType === "rename") {
                if (targetDebounceTimer) clearTimeout(targetDebounceTimer);
                targetDebounceTimer = setTimeout(() => {
                    handleTargetFileUpdate();
                }, 250);
            }
        });

        targetWatcher.on("error", (err) => {
            print(`${c.red}[Target Watcher Error] ${err.message}${c.reset}`);
        });

        print(`${c.green}[Target] Watching:${c.reset} ${c.bold}${path.basename(targetFilePath)}${c.reset} ${c.gray}(${targetFilePath})${c.reset}`);
        print(`${c.gray}Whenever this file is saved, it will be automatically sent to the room.${c.reset}`);
    } catch (err) {
        print(`${c.red}[Target Error] Failed to watch file: ${err.message}${c.reset}`);
    }
}

function handleTargetFileUpdate() {
    if (!targetFilePath || !connected) return;

    if (!fs.existsSync(targetFilePath)) {
        if (targetPendingUpdateTimer) clearTimeout(targetPendingUpdateTimer);
        targetPendingUpdateTimer = setTimeout(() => {
            if (fs.existsSync(targetFilePath)) {
                handleTargetFileUpdate();
            }
        }, 120);
        return;
    }

    if (outgoingFile) {
        if (targetPendingUpdateTimer) clearTimeout(targetPendingUpdateTimer);
        targetPendingUpdateTimer = setTimeout(handleTargetFileUpdate, 300);
        return;
    }

    try {
        let stat = fs.statSync(targetFilePath);
        if (!stat.isFile()) return;

        // If editor temporarily truncated file to 0 bytes during atomic save, wait 60ms
        if (stat.size === 0) {
            setTimeout(() => {
                try {
                    const reStat = fs.statSync(targetFilePath);
                    if (reStat.size > 0 || stat.mtimeMs > targetLastMtime) {
                        handleTargetFileUpdate();
                    }
                } catch (_) {}
            }, 60);
            return;
        }

        if (stat.mtimeMs <= targetLastMtime) return;

        const raw = fs.readFileSync(targetFilePath);
        const currentHash = crypto.createHash("sha256").update(raw).digest("hex");
        if (currentHash === targetLastFileHash) {
            targetLastMtime = stat.mtimeMs;
            return; // Exact same content, suppress echo
        }

        targetLastMtime = stat.mtimeMs;
        targetLastFileHash = currentHash;

        // Re-attach watcher in case editor used atomic rename/replacement
        if (targetWatcher) {
            try { targetWatcher.close(); } catch (_) {}
            targetWatcher = null;
        }
        try {
            targetWatcher = fs.watch(targetFilePath, (eventType) => {
                if (eventType === "change" || eventType === "rename") {
                    if (targetDebounceTimer) clearTimeout(targetDebounceTimer);
                    targetDebounceTimer = setTimeout(() => {
                        handleTargetFileUpdate();
                    }, 200);
                }
            });
        } catch (_) {}

        print(`\n${c.cyan}[Auto-sync] ${path.basename(targetFilePath)} updated (${humanSize(stat.size)}) — sending to room…${c.reset}`);
        sendFile(targetFilePath);
    } catch (err) {
        // Ignore momentary locks while editor is flushing
    }
}

/* ─── File Sharing ──────────────────────────────────────────────── */

function sendFile(filepath) {
    if (!connected) {
        print(`${c.red}[Error] Not connected to server.${c.reset}`);
        return;
    }

    if (!fs.existsSync(filepath)) {
        print(`${c.red}Path not found: ${filepath}${c.reset}`);
        return;
    }

    const stat = fs.statSync(filepath);

    if (stat.isDirectory()) {
        print(`${c.red}Folder sharing is disabled. Only regular files can be sent.${c.reset}`);
        return;
    }

    if (!stat.isFile()) {
        print(`${c.red}Only regular files can be sent.${c.reset}`);
        return;
    }

    sendWebFile(filepath, stat);
}

function sendWebFile(filepath, stat) {
    try {
        const filename = path.basename(filepath);
        const rawBuffer = fs.readFileSync(filepath);
        const deflated = zlib.deflateRawSync(rawBuffer);
        const useCompressed = deflated.length < rawBuffer.length;
        const payloadBuffer = useCompressed ? deflated : rawBuffer;
        const totalChunks = payloadBuffer.length > 0
            ? Math.ceil(payloadBuffer.length / WEB_FILE_SLICE)
            : 0;
        const transferId = crypto.randomBytes(4).toString("hex");

        const transfer = {
            backend: "web",
            id: transferId,
            filename,
            size: stat.size,
            payloadBuffer,
            compressed: useCompressed,
            totalChunks,
            acceptedBy: new Set(),
            isTransmitting: false,
            timer: null,
        };

        outgoingTransfers.set(transferId, transfer);
        outgoingFile = transfer;

        // 1. Broadcast file_offer to entire room
        sendWebAction({
            action: "file_offer",
            id: transferId,
            filename,
            size: stat.size,
            compressed: useCompressed ? 1 : 0,
            totalChunks,
            excludeSelf: true,
        });

        print(`${c.cyan}Sending ${filename} (${humanSize(stat.size)}) to room…${c.reset}`);

        // 2. Wait 150ms for peers to register transfer, then stream broadcast chunks
        transfer.timer = setTimeout(() => {
            transmitWebFile(transfer);
        }, 150);
    } catch (err) {
        print(`${c.red}Failed to prepare file transfer: ${err.message}${c.reset}`);
    }
}

function transmitWebFile(transfer) {
    if (transfer.isTransmitting) return;
    transfer.isTransmitting = true;

    const payload = transfer.payloadBuffer;
    const totalChunks = transfer.totalChunks;
    let chunkIndex = 0;

    if (totalChunks === 0) {
        sendWebAction({ action: "file_done", id: transfer.id, totalChunks: 0, excludeSelf: true });
        print(`${c.green}✓ File sent: ${transfer.filename}${c.reset}`);
        scheduleOutgoingPruning(transfer.id);
        if (outgoingFile === transfer) outgoingFile = null;
        return;
    }

    function sendNextChunk() {
        if (!connected || !outgoingTransfers.has(transfer.id)) return;

        if (chunkIndex >= totalChunks) {
            clearProgress();
            sendWebAction({ action: "file_done", id: transfer.id, totalChunks, excludeSelf: true });
            print(`${c.green}✓ File sent: ${transfer.filename}${c.reset}`);
            scheduleOutgoingPruning(transfer.id);
            if (outgoingFile === transfer) outgoingFile = null;
            if (targetPendingUpdateTimer) {
                clearTimeout(targetPendingUpdateTimer);
                targetPendingUpdateTimer = null;
                setTimeout(handleTargetFileUpdate, 50);
            }
            return;
        }

        const start = chunkIndex * WEB_FILE_SLICE;
        const slice = payload.subarray(start, start + WEB_FILE_SLICE);

        // Broadcast chunk to entire room (no "to", excludeSelf: true)
        sendWebAction({
            action: "file_chunk",
            id: transfer.id,
            i: chunkIndex,
            index: chunkIndex,
            n: totalChunks,
            totalChunks,
            d: slice.toString("base64"),
            data: slice.toString("base64"),
            excludeSelf: true,
        });

        chunkIndex++;
        const approxRawSent = Math.min(transfer.size, Math.round((chunkIndex / totalChunks) * transfer.size));
        drawProgress("Sending", approxRawSent, transfer.size);

        transfer.timer = setTimeout(sendNextChunk, WEB_CHUNK_PACE_MS);
    }

    sendNextChunk();
}

function scheduleOutgoingPruning(id) {
    const transfer = outgoingTransfers.get(id);
    if (transfer) {
        recentOutgoingTransfers.set(id, transfer);
    }
    setTimeout(() => {
        outgoingTransfers.delete(id);
        recentOutgoingTransfers.delete(id);
    }, 120_000); // Retain in memory for 2 minutes for any chunk retry requests
}

function resetIncomingWatchdog(transfer) {
    if (transfer.watchdogTimer) clearTimeout(transfer.watchdogTimer);
    if (transfer.finalized) return;

    transfer.watchdogTimer = setTimeout(() => {
        if (!transfer.finalized && transfer.receivedChunks < transfer.totalChunks) {
            requestMissingChunks(transfer);
        }
    }, 2500);
}

function requestMissingChunks(transfer) {
    if (!transfer || transfer.finalized || !connected) return;
    transfer.retryCount = (transfer.retryCount || 0) + 1;
    if (transfer.retryCount > 5) {
        if (transfer.watchdogTimer) clearTimeout(transfer.watchdogTimer);
        clearProgress();
        print(`${c.red}Transfer failed for ${transfer.filename}: connection timed out.${c.reset}`);
        incomingTransfers.delete(transfer.id);
        if (incomingFile === transfer) incomingFile = null;
        return;
    }

    const missing = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
        if (transfer.chunks[i] === null) missing.push(i);
    }

    if (missing.length === 0) {
        finalizeIncomingTransfer(transfer);
        return;
    }

    print(`${c.yellow}Recovering ${missing.length} missing parts for ${transfer.filename} (retry ${transfer.retryCount})…${c.reset}`);
    sendWebAction({
        action: "file_request_chunks",
        to: transfer.from,
        id: transfer.id,
        missing: missing.slice(0, 50),
    });

    resetIncomingWatchdog(transfer);
}

function finalizeIncomingTransfer(transfer) {
    if (!transfer || transfer.finalized) return;
    transfer.finalized = true;
    if (transfer.watchdogTimer) clearTimeout(transfer.watchdogTimer);

    clearProgress();
    try {
        const combined = transfer.totalChunks > 0
            ? Buffer.concat(transfer.chunks.map((c) => c || Buffer.alloc(0)))
            : Buffer.alloc(0);
        const fileBuffer = transfer.compressed
            ? zlib.inflateRawSync(combined)
            : combined;
        const savePath = safeFilename(transfer.filename);
        const resolvedSavePath = path.resolve(process.cwd(), savePath);

        // If incoming file is our target file, record its hash to suppress watcher echo
        if (targetFilePath && path.resolve(targetFilePath) === resolvedSavePath) {
            targetLastFileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
            if (targetDebounceTimer) {
                clearTimeout(targetDebounceTimer);
                targetDebounceTimer = null;
            }
        }

        fs.writeFileSync(savePath, fileBuffer);

        if (targetFilePath && path.resolve(targetFilePath) === resolvedSavePath) {
            try {
                targetLastMtime = fs.statSync(resolvedSavePath).mtimeMs;
            } catch (_) {}
        }
        print(`${c.green}✓ File saved: ${savePath} (${humanSize(fileBuffer.length)})${c.reset}`);
    } catch (err) {
        print(`${c.red}Failed to save incoming file: ${err.message}${c.reset}`);
    } finally {
        incomingTransfers.delete(transfer.id);
        if (incomingFile === transfer) incomingFile = null;
    }
}

function cleanupUserTransfers(peerName) {
    for (const [id, t] of incomingTransfers.entries()) {
        if (t.from.toLowerCase() === peerName.toLowerCase() && !t.finalized) {
            clearProgress();
            if (t.watchdogTimer) clearTimeout(t.watchdogTimer);
            print(`${c.red}Transfer interrupted: ${peerName} left the room.${c.reset}`);
            incomingTransfers.delete(id);
            if (incomingFile === t) incomingFile = null;
        }
    }
    for (const [id, t] of outgoingTransfers.entries()) {
        if (t.acceptedBy && typeof t.acceptedBy.delete === "function") {
            t.acceptedBy.delete(peerName);
        }
    }
}

/* ─── Progress Bar & Directory Helpers ─────────────────────────── */

function drawProgress(label, current, total) {
    if (!process.stdout.isTTY) return;
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 100;
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(
        `${c.cyan}${label}: [${bar}] ${pct}% (${humanSize(current)}/${humanSize(total)})${c.reset}`
    );
}

function clearProgress() {
    if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
    }
}

function startConnectProgress(label) {
    if (!process.stdout.isTTY) return;
    connectProgress = 0;
    if (connectTimer) clearInterval(connectTimer);
    connectTimer = setInterval(() => {
        if (connectProgress < CONNECT_MAX) {
            connectProgress++;
            const filled = Math.round((connectProgress / 100) * BAR_WIDTH);
            const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`${c.cyan}${label} [${bar}] ${connectProgress}%${c.reset}`);
        }
    }, CONNECT_STEP);
}

function finishConnectProgress() {
    if (!connectTimer) return;
    clearInterval(connectTimer);
    connectTimer = null;
    clearProgress();
}

function printUserList() {
    const users = Array.from(roomUsers);
    print(
        `${c.bold}Online in ${room} (${users.length}):${c.reset} ` +
        users.map((u) => (u.toLowerCase() === username.toLowerCase() ? `${c.green}${u} (you)${c.reset}` : u)).join("  ")
    );
}

function print(text) {
    if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
    }
    console.log(text);
    promptInput(true);
}

function humanSize(bytes) {
    if (bytes < 1024)    return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
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
                return `  ${c.cyan}[DIR]${c.reset}  ${entry.name}`;
            }
            return `  [FILE] ${entry.name} ${c.gray}(${humanSize(stat.size)})${c.reset}`;
        });

        print(
            `${c.bold}Current directory:${c.reset} ${cwd}\n` +
            lines.join("\n")
        );
    } catch (err) {
        print(`${c.red}Failed to list current directory: ${err.message}${c.reset}`);
    }
}

function safeFilename(name) {
    const clean = path.basename(String(name || "file").replace(/[/\\]/g, "_"));
    return clean || "file";
}
