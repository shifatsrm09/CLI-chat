/**
 * cli-chat — Multi-Backend Terminal Client
 * Real-time terminal chat, room hosting/joining, whisper messaging, and file sharing.
 *
 * Supported Backends:
 *   1. syncplay_server — Serverless Syncplay protocol relay (syncplay.pl:8995)
 *   2. web_server      — CFAT Edge Worker relay (api.cfat.site / chat.cfat.site)
 *
 * Commands:
 *   /help               — show this list
 *   /list               — show online users in the room
 *   /room [name]        — show current room or switch room
 *   /ls                 — list files in the current directory
 *   /dir                — show current working directory
 *   /send <path>        — offer a file to the room
 *   /w <user> <msg>     — private (whisper) message
 *   /quit               — disconnect and exit
 */

"use strict";

const net      = require("net");
const tls      = require("tls");
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

const SYNCPLAY_HOST          = getArgValue("--host") || "syncplay.pl";
const SYNCPLAY_PORT          = Number(getArgValue("--port")) || 8995;
const CFAT_WS_URL            = getArgValue("--ws-url") || "wss://api.cfat.site/ws";

const DEFAULT_MAX_CHAT_LEN   = 150;
const MAX_USERNAME_LEN       = 24;
const MAX_ROOM_NAME_LEN      = 35;
const CHUNK_ENVELOPE_RESERVE = 52;       // reserves space for CC|{"t":"c","m":"xxxx","i":999,"n":999,"d":""}
const MAX_TEXT_CHUNKS        = 256;      // up to ~25 KB per text message
const CHUNK_TIMEOUT_MS       = 20_000;   // expire incomplete chunk assemblies
const CHAT_CHUNK_PACE_MS     = 25;       // pacing between 150-char chat chunks
const SYNCPLAY_FILE_SLICE    = 7200;     // 7200 bytes = 9600 base64 chars (< 10000 Syncplay limit)
const SYNCPLAY_CHUNK_PACE_MS = 45;       // pacing between Syncplay file chunks
const WEB_FILE_SLICE         = 16 * 1024; // 16 KB raw payload per chunk (< 32KB/64KB frame limits)
const WEB_CHUNK_PACE_MS      = 25;        // 25ms pacing (~40 msgs/sec, fast and smooth under 800/5s limit)
const HEARTBEAT_MS           = 1500;     // Syncplay State keepalive interval
const WEB_PING_INTERVAL_MS   = 25_000;   // Cloudflare Worker keepalive ping
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

let serverType       = sanitizeServerType(getArgValue("--server") || getArgValue("-server"));
let username         = getArgValue("--user") || getArgValue("-u") || "";
let room             = getArgValue("--room") || getArgValue("-r") || "";
let maxChatLength    = DEFAULT_MAX_CHAT_LEN;

// Syncplay socket handles
let rawSocket        = null;
let tlsSocket        = null;

// Web socket handles
let webSocket        = null;
let webPingTimer     = null;

let connected        = false;
let quitting         = false;
let rl               = null;
let heartbeatTimer   = null;
let lastServerPing   = 0;
let connectTimer     = null;
let connectProgress  = 0;
let connectionAttempt = null;
let reconnectTimer   = null;
let retryCount       = 0;
let nextMsgCounter   = 0;
let pendingListPrint = false;

const CLIENT_INSTANCE_ID = "cli-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let usernameTaken    = false;

/** Online users in the current room */
const roomUsers = new Set();

/** Pending incoming text/control chunk assemblies (Syncplay): key (sender:msgId) -> { total, received, parts, createdAt } */
const pendingTextChunks = new Map();
const completedTextKeys = new Set();

/** Outgoing transfer waiting for accept or currently sending */
const outgoingTransfers       = new Map();
const recentOutgoingTransfers = new Map();
let outgoingFile              = null;

/** Incoming transfer being reassembled */
const incomingTransfers       = new Map();
let incomingFile              = null;

/** Outgoing chat queue so multi-chunk messages are paced cleanly (Syncplay) */
const chatSendQueue = [];
let chatQueueTimer  = null;

/* ─── Boot: select backend, ask username, room, then connect ───── */

(async function boot() {
    showHeader();

    try {
        if (!serverType) {
            serverType = await selectServerMenu();
        }

        if (!username) {
            username = await askQuestion(`${c.bold}Username: ${c.reset}`);
        }
        username = sanitizeUsername(username);
        if (!username) {
            console.log(`${c.red}Username cannot be empty.${c.reset}`);
            process.exit(1);
        }

        if (!room) {
            while (!room) {
                const roomInput = await askQuestion(`${c.bold}Enter 4-digit room code: ${c.reset}`);
                const clean = sanitizeRoomName(roomInput);
                if (/^\d{4}$/.test(clean)) {
                    room = clean;
                } else {
                    console.log(`${c.red}Please enter a valid 4-digit code (e.g. 1234).${c.reset}`);
                }
            }
        } else {
            room = sanitizeRoomName(room);
        }
    } catch {
        process.exit(1);
    }

    if (serverType === "syncplay_server") {
        console.log(
            `${c.gray}Backend:${c.reset} ${c.bold}syncplay_server${c.reset} ${c.gray}(${SYNCPLAY_HOST}:${SYNCPLAY_PORT})${c.reset} ` +
            `${c.gray}| User:${c.reset} ${c.bold}${username}${c.reset} ` +
            `${c.gray}| Room:${c.reset} ${c.bold}${room}${c.reset}`
        );
    } else {
        console.log(
            `${c.gray}Backend:${c.reset} ${c.bold}web_server${c.reset} ${c.gray}(api.cfat.site / chat.cfat.site)${c.reset} ` +
            `${c.gray}| User:${c.reset} ${c.bold}${username}${c.reset} ` +
            `${c.gray}| Room:${c.reset} ${c.bold}${room}${c.reset}`
        );
    }

    startChat();
})();

function getArgValue(flag) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1];
    }
    return null;
}

function sanitizeServerType(val) {
    if (!val) return null;
    const lower = String(val).toLowerCase().trim();
    if (lower === "syncplay_server" || lower === "syncplay") return "syncplay_server";
    if (lower === "web_server" || lower === "web" || lower === "cfat") return "web_server";
    return null;
}

function sanitizeUsername(name) {
    return String(name || "").trim().slice(0, MAX_USERNAME_LEN);
}

function sanitizeRoomName(name) {
    return String(name || "").trim().slice(0, MAX_ROOM_NAME_LEN);
}

function generateRoomCode() {
    const num = crypto.randomInt(1000, 10000);
    return String(num);
}

function showHeader() {
    if (process.stdout.isTTY) console.clear();
    console.log(
        `\n${c.bold}${c.cyan}  cli-chat${c.reset}  ${c.gray}terminal messenger (Syncplay & CFAT Edge)${c.reset}\n` +
        `${c.gray}  Type /help for available commands${c.reset}\n`
    );
}

function askQuestion(query) {
    return new Promise((resolve) => {
        const promptRl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        promptRl.question(query, (answer) => {
            promptRl.close();
            resolve(answer.trim());
        });
    });
}

/* ─── Server / Backend Selection Menu ─────────────────────────── */

function selectServerMenu() {
    if (!process.stdin.isTTY) {
        return Promise.resolve("syncplay_server");
    }

    return new Promise((resolve, reject) => {
        const options = [
            {
                id: "syncplay_server",
                label: "syncplay_server",
                desc: "Syncplay protocol relay (syncplay.pl:8995)"
            },
            {
                id: "web_server",
                label: "web_server",
                desc: "CFAT Edge Worker relay (api.cfat.site / chat.cfat.site)"
            }
        ];
        let index = 0;

        const renderMenu = () => {
            console.clear();
            console.log(
                `\n${c.bold}${c.cyan}  cli-chat${c.reset}  ${c.gray}terminal messenger${c.reset}\n` +
                `${c.gray}  Select connection backend with arrow keys and press Enter${c.reset}\n`
            );

            options.forEach((opt, i) => {
                const pointer = i === index ? `${c.green}❯${c.reset}` : " ";
                const title   = i === index ? `${c.bold}${c.green}${opt.label}${c.reset}` : opt.label;
                console.log(` ${pointer} ${title} ${c.gray}— ${opt.desc}${c.reset}`);
            });
            console.log("");
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

            if (key.name === "up" || key.name === "k") {
                index = (index - 1 + options.length) % options.length;
                renderMenu();
                return;
            }

            if (key.name === "down" || key.name === "j") {
                index = (index + 1) % options.length;
                renderMenu();
                return;
            }

            if (key.name === "return" || key.name === "enter") {
                const choice = options[index].id;
                cleanup();
                console.clear();
                showHeader();
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

/* ─── Host / Join Room Selector (Syncplay) ─────────────────────── */

function selectRoomAction() {
    if (!process.stdin.isTTY) {
        return Promise.resolve("host");
    }

    return new Promise((resolve, reject) => {
        const options = [
            { id: "host", label: "Host a room", desc: "Create a new room and get a shareable room code" },
            { id: "join", label: "Join a room", desc: "Enter an existing room name/code to join" },
        ];
        let index = 0;

        const renderMenu = () => {
            console.clear();
            console.log(
                `\n${c.bold}${c.cyan}  cli-chat${c.reset}  ${c.gray}syncplay terminal messenger${c.reset}\n` +
                `${c.gray}  Logged in as:${c.reset} ${c.bold}${username}${c.reset}\n` +
                `${c.gray}  Select an option with arrow keys and press Enter${c.reset}\n`
            );

            options.forEach((opt, i) => {
                const pointer = i === index ? `${c.green}❯${c.reset}` : " ";
                const title   = i === index ? `${c.bold}${opt.label}${c.reset}` : opt.label;
                console.log(` ${pointer} ${title} ${c.gray}— ${opt.desc}${c.reset}`);
            });
            console.log("");
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

            if (key.name === "up" || key.name === "k") {
                index = (index - 1 + options.length) % options.length;
                renderMenu();
                return;
            }

            if (key.name === "down" || key.name === "j") {
                index = (index + 1) % options.length;
                renderMenu();
                return;
            }

            if (key.name === "return" || key.name === "enter") {
                const choice = options[index].id;
                cleanup();
                console.clear();
                showHeader();
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

/* ─── Chat Readline Lifecycle ──────────────────────────────────── */

function startChat() {
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${c.bold}${c.green}${username}${c.reset}: `,
    });

    rl.on("line", handleInput);
    rl.on("close", () => {
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

/* ─── Connection Dispatcher ────────────────────────────────────── */

function connect(isReconnect = false) {
    if (quitting) return;
    cleanupConnection();

    if (serverType === "web_server") {
        connectWeb(isReconnect);
    } else {
        connectSyncplay(isReconnect);
    }
}

/* ─── Web Server Connection (Cloudflare Worker api.cfat.site) ──── */

function connectWeb(isReconnect = false) {
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
        startProgressBar();
    }

    attempt.timeoutTimer = setTimeout(() => {
        if (connectionAttempt !== attempt || attempt.completed || attempt.failed) return;
        handleConnectionDrop(attempt, "Connection to api.cfat.site timed out");
    }, CONNECT_TIMEOUT_MS);

    const wsUrl = `${CFAT_WS_URL}?room=${encodeURIComponent(room)}&user=${encodeURIComponent(username)}&clientId=${encodeURIComponent(CLIENT_INSTANCE_ID)}&game=chat`;

    try {
        const ws = new WebSocketClient(wsUrl);
        webSocket = ws;

        const onOpen = () => {
            if (connectionAttempt !== attempt || attempt.failed || quitting) return;
            if (attempt.timeoutTimer) {
                clearTimeout(attempt.timeoutTimer);
                attempt.timeoutTimer = null;
            }
            attempt.completed = true;
            connected = true;
            usernameTaken = false;
            retryCount = 0;

            roomUsers.clear();
            roomUsers.add(username);
            updatePrompt();

            if (!attempt.reconnect) {
                finishProgressBar();
            }

            print(
                `${c.gray}[System] Connected to api.cfat.site | ` +
                `Room: ${c.bold}${room}${c.reset}${c.gray} | ` +
                `User: ${c.bold}${username}${c.reset}${c.gray} | ` +
                `Type /help for commands.${c.reset}`
            );

            // Periodic ping to keep Cloudflare Worker edge WebSocket open indefinitely
            if (webPingTimer) clearInterval(webPingTimer);
            webPingTimer = setInterval(() => {
                if (connected && webSocket && webSocket.readyState === 1) {
                    try {
                        webSocket.send(JSON.stringify({ type: "ping" }));
                    } catch (_) {}
                }
            }, WEB_PING_INTERVAL_MS);
        };

        const onMessage = (data) => {
            if (connectionAttempt !== attempt) return;
            handleWebFrame(attempt, data);
        };

        const onClose = (code, reason) => {
            if (connectionAttempt !== attempt) return;
            if (code === 4003 || usernameTaken) {
                finishProgressBar();
                cleanupConnection();
                print(`${c.red}[System] Handle "${username}" is already in use in room ${room}.${c.reset}`);
                promptRename();
                return;
            }
            const rStr = reason ? ` (${reason})` : "";
            handleConnectionDrop(attempt, `Disconnected from api.cfat.site${rStr}`);
        };

        const onError = (errMsg) => {
            if (connectionAttempt !== attempt) return;
            handleConnectionDrop(attempt, errMsg || "WebSocket connection error");
        };

        if (typeof ws.on === "function") {
            ws.on("open", onOpen);
            ws.on("message", onMessage);
            ws.on("close", (code, reason) => onClose(code, reason ? reason.toString() : ""));
            ws.on("error", (err) => onError(err?.message));
        } else {
            ws.addEventListener("open", onOpen);
            ws.addEventListener("message", (ev) => onMessage(ev.data));
            ws.addEventListener("close", (ev) => onClose(ev.code, ev.reason));
            ws.addEventListener("error", (ev) => onError(ev.message));
        }
    } catch (err) {
        handleConnectionDrop(attempt, err?.message || "Failed to initialize WebSocket");
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

    // 1. Room State (initial snapshot upon joining)
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
            if (joinedUser !== username) {
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
            if (leftUser !== username) {
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

    // 4. Standard Chat Message (interoperable with chat.cfat.site & other CLI clients)
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

    // 7. System Notice / Error
    if (msg.type === "system_notice") {
        print(`${c.yellow}[System] ${msg.message}${c.reset}`);
        return;
    }

    if (msg.type === "error") {
        if (msg.code === "USERNAME_TAKEN") {
            usernameTaken = true;
        }
        print(`${c.red}[Error] ${msg.error || msg.message || "Server error"}${c.reset}`);
        return;
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
            updatePrompt();
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

            if (!id || !sender || sender === username) break;

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
                finalizeIncomingFile(transfer);
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
            for (const idx of msg.missing) {
                if (!Number.isInteger(idx) || idx < 0 || idx >= totalChunks) continue;
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
                    data: slice.toString("base64"),
                });
            }
            sendWebAction({
                action: "file_done",
                to: sender,
                id: transfer.id,
                totalChunks,
            });
            break;
        }

        case "file_chunk": {
            const transfer = incomingTransfers.get(msg.id);
            if (!transfer || transfer.finalized) break;
            if (sender && transfer.from.toLowerCase() !== sender.toLowerCase()) break;

            const idx   = Number(msg.i !== undefined ? msg.i : msg.index);
            const total = Number(msg.n !== undefined ? msg.n : msg.totalChunks);
            const b64   = String(msg.d !== undefined ? msg.d : (msg.data || ""));

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
                finalizeIncomingFile(transfer);
            }
            break;
        }

        case "file_done": {
            const transfer = incomingTransfers.get(msg.id);
            if (!transfer || transfer.finalized) break;
            if (sender && transfer.from.toLowerCase() !== sender.toLowerCase()) break;

            if (transfer.receivedChunks >= transfer.totalChunks) {
                finalizeIncomingFile(transfer);
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

function sendWebAction(payloadObj) {
    if (!webSocket || webSocket.readyState !== 1) return false;
    try {
        webSocket.send(JSON.stringify({
            type: "action",
            ...payloadObj,
        }));
        return true;
    } catch {
        return false;
    }
}

/* ─── Syncplay Connection (TCP + StartTLS) ──────────────────────── */

function connectSyncplay(isReconnect = false) {
    const attempt = {
        backend: "syncplay_server",
        completed: false,
        failed: false,
        reconnect: isReconnect,
        timeoutTimer: null,
        phase: "tcp", // "tcp" -> "starttls" -> "tls" -> "hello" -> "ready"
    };
    connectionAttempt = attempt;

    if (!isReconnect) {
        startProgressBar();
    }

    attempt.timeoutTimer = setTimeout(() => {
        if (connectionAttempt !== attempt || attempt.completed || attempt.failed) return;
        handleConnectionDrop(attempt, "Connection to syncplay.pl timed out");
    }, CONNECT_TIMEOUT_MS);

    const sock = net.createConnection({ host: SYNCPLAY_HOST, port: SYNCPLAY_PORT });
    rawSocket = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);

    let tcpBuffer = "";

    const onTcpData = (chunk) => {
        if (connectionAttempt !== attempt || attempt.phase !== "starttls") return;
        tcpBuffer += chunk.toString("utf8");
        const nlIdx = tcpBuffer.indexOf("\n");
        if (nlIdx === -1) return;

        const line = tcpBuffer.slice(0, nlIdx).trim();
        const remainder = tcpBuffer.slice(nlIdx + 1);
        sock.removeListener("data", onTcpData);

        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch {
            handleConnectionDrop(attempt, "Invalid StartTLS response from Syncplay server");
            return;
        }

        if (parsed?.TLS?.startTLS !== "true") {
            handleConnectionDrop(attempt, "Syncplay server rejected StartTLS");
            return;
        }

        upgradeToTls(attempt, sock, remainder);
    };

    sock.on("connect", () => {
        if (connectionAttempt !== attempt || attempt.failed) return;
        attempt.phase = "starttls";
        sock.on("data", onTcpData);
        sock.write(JSON.stringify({ TLS: { startTLS: "send" } }) + "\r\n");
    });

    sock.on("error", (err) => {
        if (connectionAttempt !== attempt) return;
        handleConnectionDrop(attempt, err.message || "TCP error");
    });

    sock.on("close", () => {
        if (connectionAttempt !== attempt || attempt.phase === "tls" || attempt.phase === "hello" || attempt.phase === "ready") return;
        handleConnectionDrop(attempt, "TCP connection closed");
    });
}

function upgradeToTls(attempt, sock, initialBuffer) {
    if (connectionAttempt !== attempt || attempt.failed || quitting) return;
    attempt.phase = "tls";

    const secureSock = tls.connect({
        socket: sock,
        servername: SYNCPLAY_HOST,
        rejectUnauthorized: true,
    });
    tlsSocket = secureSock;

    let tlsBuffer = initialBuffer || "";

    secureSock.on("secureConnect", () => {
        if (connectionAttempt !== attempt || attempt.failed || quitting) return;
        attempt.phase = "hello";

        sendRawJson({
            Hello: {
                username,
                room: { name: room },
                version: "1.2.255",
                realversion: "1.7.6",
                features: {
                    sharedPlaylists: true,
                    chat: true,
                    featureList: true,
                    readiness: true,
                    managedRooms: true,
                    persistentRooms: false,
                    uiMode: "GUI",
                },
            },
        });
    });

    secureSock.on("data", (chunk) => {
        if (connectionAttempt !== attempt) return;
        tlsBuffer += chunk.toString("utf8");

        if (tlsBuffer.length > 128 * 1024) {
            tlsBuffer = "";
            handleConnectionDrop(attempt, "Receive buffer overflow");
            return;
        }

        let nlIdx;
        while ((nlIdx = tlsBuffer.indexOf("\n")) !== -1) {
            const line = tlsBuffer.slice(0, nlIdx).trim();
            tlsBuffer = tlsBuffer.slice(nlIdx + 1);
            if (!line) continue;

            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            handleSyncplayFrame(attempt, msg);
        }
    });

    secureSock.on("error", (err) => {
        if (connectionAttempt !== attempt) return;
        handleConnectionDrop(attempt, err.message || "TLS socket error");
    });

    secureSock.on("close", () => {
        if (connectionAttempt !== attempt) return;
        handleConnectionDrop(attempt, "Disconnected from Syncplay server");
    });
}

function handleSyncplayFrame(attempt, root) {
    // 1. Hello handshake response
    if (root.Hello && typeof root.Hello === "object") {
        const hello = root.Hello;
        const assignedUser = String(hello.username || username).trim();
        const assignedRoom = String(hello.room?.name || room).trim();
        const serverMaxChat = Number(hello.features?.maxChatMessageLength) || DEFAULT_MAX_CHAT_LEN;

        const nameChanged = assignedUser !== username;
        username = assignedUser;
        room = assignedRoom;
        maxChatLength = Math.max(50, Math.min(4096, serverMaxChat));

        if (attempt.timeoutTimer) {
            clearTimeout(attempt.timeoutTimer);
            attempt.timeoutTimer = null;
        }
        attempt.completed = true;
        attempt.phase = "ready";
        connected = true;
        retryCount = 0;
        lastServerPing = 0;

        roomUsers.clear();
        roomUsers.add(username);
        updatePrompt();

        if (!attempt.reconnect) {
            finishProgressBar();
        }

        print(
            `${c.gray}[System] Connected to ${SYNCPLAY_HOST}:${SYNCPLAY_PORT} | ` +
            `Room: ${c.bold}${room}${c.reset}${c.gray} | ` +
            `User: ${c.bold}${username}${c.reset}${c.gray}` +
            (nameChanged ? ` (renamed by server)` : "") +
            ` | Type /help for commands.${c.reset}`
        );

        sendStateHeartbeat(null);
        sendRawJson({ List: null });

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
            if (connected) {
                sendStateHeartbeat(lastServerPing || null);
                pruneExpiredTextChunks();
            }
        }, HEARTBEAT_MS);
        return;
    }

    // 2. State keepalive ping from Syncplay server
    if (root.State && typeof root.State === "object") {
        const lat = root.State.ping?.latencyCalculation;
        if (lat) {
            lastServerPing = lat;
            sendStateHeartbeat(lat);
        }
        return;
    }

    // 3. List response (room occupants)
    if (root.List && typeof root.List === "object") {
        roomUsers.clear();
        roomUsers.add(username);
        const roomMap = root.List[room];
        if (roomMap && typeof roomMap === "object") {
            for (const uname of Object.keys(roomMap)) {
                const clean = uname.trim();
                if (clean) roomUsers.add(clean);
            }
        }
        if (pendingListPrint) {
            pendingListPrint = false;
            printUserList();
        }
        return;
    }

    // 4. Set events (user join/leave, room change, playlistChange file chunks)
    if (root.Set && typeof root.Set === "object") {
        const setObj = root.Set;

        if (setObj.room?.name) {
            room = String(setObj.room.name).trim();
        }

        if (setObj.user && typeof setObj.user === "object") {
            for (const [uname, udata] of Object.entries(setObj.user)) {
                const cleanName = uname.trim();
                if (!cleanName || !udata || typeof udata !== "object") continue;

                const userRoom = udata.room?.name ? String(udata.room.name).trim() : room;
                const evt = udata.event || {};

                if (evt.joined && userRoom === room) {
                    roomUsers.add(cleanName);
                    if (cleanName !== username) {
                        print(`${c.gray}[System] ${cleanName} joined the room${c.reset}`);
                    }
                } else if (evt.left || (userRoom && userRoom !== room)) {
                    const wasInRoom = roomUsers.delete(cleanName);
                    cleanupUserTransfers(cleanName);
                    if (cleanName !== username && wasInRoom) {
                        print(`${c.gray}[System] ${cleanName} left the room${c.reset}`);
                    }
                }
            }
        }

        if (setObj.playlistChange && typeof setObj.playlistChange === "object") {
            const pc = setObj.playlistChange;
            if (pc.user && pc.user !== username && Array.isArray(pc.files) && pc.files.length === 2) {
                if (typeof pc.files[0] === "string" && pc.files[0].startsWith("CCFILE|")) {
                    handleIncomingSyncplayFileChunk(pc.user, pc.files[0], pc.files[1]);
                }
            }
        }
        return;
    }

    // 5. Chat messages (plain chat + CC| protocol messages & 150-char chunks)
    if (root.Chat && typeof root.Chat === "object") {
        const sender = String(root.Chat.username || "").trim();
        const message = String(root.Chat.message || "");
        if (!sender) return;
        roomUsers.add(sender);
        if (sender.toLowerCase() === username.toLowerCase()) return; // ignore our own echo
        handleIncomingSyncplayChat(sender, message);
        return;
    }

    // 6. Server Error
    if (root.Error && typeof root.Error === "object") {
        const errMsg = root.Error.message || "Unknown server error";
        print(`${c.red}[Error] ${errMsg}${c.reset}`);
    }
}

function sendRawJson(obj) {
    if (!tlsSocket || tlsSocket.destroyed) return false;
    try {
        tlsSocket.write(JSON.stringify(obj) + "\r\n");
        return true;
    } catch {
        return false;
    }
}

function sendStateHeartbeat(latencyCalc = null) {
    const ping = {
        clientLatencyCalculation: Date.now() / 1000,
        clientRtt: 0.0,
    };
    if (latencyCalc) {
        ping.latencyCalculation = latencyCalc;
    }
    sendRawJson({
        State: {
            ping,
            playstate: {
                position: 0.0,
                paused: true,
                doSeek: false,
            },
        },
    });
}

function queueRawChat(chatStr) {
    chatSendQueue.push(chatStr);
    processChatQueue();
}

function processChatQueue() {
    if (chatQueueTimer || chatSendQueue.length === 0 || !connected) return;

    const nextStr = chatSendQueue.shift();
    sendRawJson({ Chat: nextStr });

    if (chatSendQueue.length > 0) {
        chatQueueTimer = setTimeout(() => {
            chatQueueTimer = null;
            processChatQueue();
        }, CHAT_CHUNK_PACE_MS);
    }
}

function sendProtocolMessage(payloadObj) {
    if (!connected) {
        print(`${c.red}[Error] Not connected to Syncplay server.${c.reset}`);
        return false;
    }

    const jsonStr = JSON.stringify(payloadObj);
    const singleFrame = `CC|${jsonStr}`;

    if (singleFrame.length <= maxChatLength && Buffer.byteLength(singleFrame, "utf8") <= maxChatLength) {
        queueRawChat(singleFrame);
        return true;
    }

    const b64 = Buffer.from(jsonStr, "utf8").toString("base64");
    const sliceLen = Math.max(20, maxChatLength - CHUNK_ENVELOPE_RESERVE);
    const totalChunks = Math.ceil(b64.length / sliceLen);

    if (totalChunks > MAX_TEXT_CHUNKS) {
        print(`${c.red}[Error] Message is too large (${totalChunks} chunks, max ${MAX_TEXT_CHUNKS}).${c.reset}`);
        return false;
    }

    const msgId = (++nextMsgCounter).toString(36);
    for (let i = 0; i < totalChunks; i++) {
        const slice = b64.slice(i * sliceLen, (i + 1) * sliceLen);
        const chunkFrame = `CC|${JSON.stringify({ t: "c", m: msgId, i, n: totalChunks, d: slice })}`;
        queueRawChat(chunkFrame);
    }
    return true;
}

function sendSyncplayUserChatMessage(text) {
    if (!connected) {
        print(`${c.red}[Error] Not connected to Syncplay server.${c.reset}`);
        return;
    }

    if (
        !text.startsWith("CC|") &&
        text.length <= maxChatLength &&
        Buffer.byteLength(text, "utf8") <= maxChatLength
    ) {
        queueRawChat(text);
        return;
    }

    sendProtocolMessage({ t: "m", c: text });
}

function handleIncomingSyncplayChat(sender, msg) {
    if (!msg.startsWith("CC|")) {
        print(`${c.bold}${c.blue}${sender}${c.reset}: ${msg}`);
        return;
    }

    let obj;
    try {
        obj = JSON.parse(msg.slice(3));
    } catch {
        return;
    }

    if (!obj || typeof obj !== "object") return;

    if (obj.t === "c") {
        handleIncomingTextChunk(sender, obj);
        return;
    }

    handleSyncplayProtocolPayload(sender, obj);
}

function handleIncomingTextChunk(sender, chunkObj) {
    pruneExpiredTextChunks();

    const msgId = String(chunkObj.m ?? "").trim();
    const idx   = Number(chunkObj.i);
    const total = Number(chunkObj.n);
    const slice = String(chunkObj.d ?? "");

    if (
        !msgId ||
        msgId.length > 16 ||
        !Number.isInteger(idx) ||
        !Number.isInteger(total) ||
        total < 2 ||
        total > MAX_TEXT_CHUNKS ||
        idx < 0 ||
        idx >= total ||
        !slice
    ) {
        return;
    }

    const key = `${sender}:${msgId}`;
    if (completedTextKeys.has(key)) return;

    let entry = pendingTextChunks.get(key);
    if (!entry) {
        entry = {
            total,
            received: 0,
            parts: new Array(total).fill(null),
            createdAt: Date.now(),
        };
        pendingTextChunks.set(key, entry);
    }

    if (entry.total !== total || entry.parts[idx] !== null) return;

    entry.parts[idx] = slice;
    entry.received++;

    if (entry.received < entry.total) return;

    pendingTextChunks.delete(key);
    completedTextKeys.add(key);
    if (completedTextKeys.size > 256) {
        const oldest = completedTextKeys.values().next().value;
        completedTextKeys.delete(oldest);
    }

    let decodedObj;
    try {
        const jsonStr = Buffer.from(entry.parts.join(""), "base64").toString("utf8");
        decodedObj = JSON.parse(jsonStr);
    } catch {
        return;
    }

    if (decodedObj && typeof decodedObj === "object" && decodedObj.t !== "c") {
        handleSyncplayProtocolPayload(sender, decodedObj);
    }
}

function pruneExpiredTextChunks() {
    const cutoff = Date.now() - CHUNK_TIMEOUT_MS;
    for (const [key, entry] of pendingTextChunks.entries()) {
        if (entry.createdAt < cutoff) {
            pendingTextChunks.delete(key);
        }
    }
}

function handleSyncplayProtocolPayload(sender, msg) {
    switch (msg.t) {
        case "m":
            if (typeof msg.c === "string") {
                print(`${c.bold}${c.blue}${sender}${c.reset}: ${msg.c}`);
            }
            break;

        case "w":
            if (msg.to === username && typeof msg.c === "string") {
                print(`${c.magenta}[PM from ${sender}]${c.reset} ${msg.c}`);
            }
            break;

        case "fm": {
            const filename = String(msg.n || "file").replace(/[/\\]/g, "_");
            const size     = Number(msg.s) || 0;
            const id       = String(msg.id || "");
            const z        = Number(msg.z) === 1;
            const chunks   = Number(msg.k) || 0;

            if (!id) break;

            rl.question(
                `\n${c.yellow}${sender} wants to send ${c.bold}${filename}${c.reset}${c.yellow} ` +
                `(file, ${humanSize(size)}). Accept? [y/N]: ${c.reset}`,
                (answer) => {
                    if (answer.trim().toLowerCase() === "y") {
                        incomingFile = {
                            backend: "syncplay",
                            from: sender,
                            id,
                            filename,
                            size,
                            compressed: z,
                            totalChunks: chunks,
                            chunks: new Array(Math.max(1, chunks)).fill(null),
                            receivedChunks: 0,
                            receivedEncodedBytes: 0,
                            doneSignal: false,
                        };
                        sendProtocolMessage({ t: "fa", to: sender, id });
                        print(`${c.gray}Receiving file ${filename}…${c.reset}`);
                        if (size === 0 && chunks === 0) {
                            finalizeIncomingFile();
                        }
                    } else {
                        sendProtocolMessage({ t: "fr", to: sender, id });
                        promptInput();
                    }
                }
            );
            break;
        }

        case "fa": {
            if (msg.to !== username || !outgoingFile || outgoingFile.id !== msg.id) break;
            if (outgoingFile.acceptedBy) {
                sendProtocolMessage({
                    t: "ferr",
                    to: sender,
                    c: "Someone else already accepted that file transfer.",
                });
                break;
            }
            outgoingFile.acceptedBy = sender;
            print(`${c.green}${sender} accepted the file. Sending…${c.reset}`);
            transmitSyncplayFile(outgoingFile, sender);
            break;
        }

        case "fr": {
            if (msg.to !== username || !outgoingFile || outgoingFile.id !== msg.id) break;
            if (!outgoingFile.acceptedBy) {
                print(`${c.yellow}${sender} declined the file.${c.reset}`);
                outgoingFile = null;
            }
            break;
        }

        case "fd": {
            if (msg.to !== username || !incomingFile || incomingFile.id !== msg.id) break;
            incomingFile.doneSignal = true;
            if (incomingFile.receivedChunks >= incomingFile.totalChunks) {
                finalizeIncomingFile();
            }
            break;
        }

        case "fc": {
            if (incomingFile && incomingFile.from === sender && (!msg.id || incomingFile.id === msg.id)) {
                clearProgress();
                print(`${c.red}Transfer cancelled by ${sender}.${c.reset}`);
                incomingFile = null;
            }
            break;
        }

        case "ferr": {
            if (msg.to === username && msg.c) {
                if (incomingFile && incomingFile.from === sender) {
                    incomingFile = null;
                }
                print(`${c.red}[Error] ${msg.c}${c.reset}`);
            }
            break;
        }
    }
}

/* ─── Unified Connection Cleanup & Reconnect ───────────────────── */

function handleConnectionDrop(attempt, reason) {
    if (quitting || connectionAttempt !== attempt || attempt.failed) return;
    attempt.failed = true;
    const wasConnected = connected;
    cleanupConnection();

    if (wasConnected) {
        clearProgress();
        print(`${c.yellow}[System] Disconnected (${reason}). Reconnecting…${c.reset}`);
    } else if (retryCount === 0) {
        stopProgressBar();
        clearProgress();
        print(`${c.yellow}[System] Connection issue (${reason}). Retrying…${c.reset}`);
    }

    const delay = Math.min(15_000, 1500 * Math.pow(1.5, Math.min(retryCount, 6)));
    retryCount++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!quitting) connect(true);
    }, delay);
}

function cleanupConnection() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (webPingTimer) {
        clearInterval(webPingTimer);
        webPingTimer = null;
    }
    if (chatQueueTimer) {
        clearTimeout(chatQueueTimer);
        chatQueueTimer = null;
    }
    chatSendQueue.length = 0;

    if (connectionAttempt?.timeoutTimer) {
        clearTimeout(connectionAttempt.timeoutTimer);
        connectionAttempt.timeoutTimer = null;
    }

    connected = false;

    if (tlsSocket) {
        tlsSocket.removeAllListeners();
        try { tlsSocket.destroy(); } catch {}
        tlsSocket = null;
    }
    if (rawSocket) {
        rawSocket.removeAllListeners();
        try { rawSocket.destroy(); } catch {}
        rawSocket = null;
    }
    if (webSocket) {
        webSocket.removeAllListeners();
        try { webSocket.close(); } catch {}
        webSocket = null;
    }
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
        if (outgoingFile?.acceptedBy) {
            if (serverType === "web_server") {
                sendWebAction({ action: "file_cancel", to: outgoingFile.acceptedBy, id: outgoingFile.id });
            } else {
                sendProtocolMessage({ t: "fc", id: outgoingFile.id });
            }
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
        if (serverType === "web_server") {
            printUserList();
            if (webSocket && webSocket.readyState === 1) {
                try { webSocket.send(JSON.stringify({ type: "get_room_state" })); } catch (_) {}
            }
        } else {
            pendingListPrint = true;
            sendRawJson({ List: null });
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

        if (serverType === "web_server") {
            print(`${c.gray}[System] Switching to room:${c.reset} ${c.bold}${c.cyan}${room}${c.reset}…`);
            connect(false);
        } else {
            sendRawJson({ Set: { room: { name: room } } });
            sendRawJson({ List: null });
            print(`${c.gray}[System] Switched to room:${c.reset} ${c.bold}${c.cyan}${room}${c.reset}`);
        }
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

    if (input.startsWith("/w ")) {
        const parts   = input.slice(3).trim().split(" ");
        const to      = parts.shift();
        const content = parts.join(" ").trim();
        if (!to || !content) {
            print(`${c.red}Usage: /w <username> <message>${c.reset}`);
            return;
        }
        if (serverType === "web_server") {
            if (sendWebAction({ action: "whisper", to, message: content })) {
                print(`${c.gray}[PM → ${to}] ${content}${c.reset}`);
            }
        } else {
            if (sendProtocolMessage({ t: "w", to, c: content })) {
                print(`${c.gray}[PM → ${to}] ${content}${c.reset}`);
            }
        }
        return;
    }

    if (input.startsWith("/")) {
        print(`${c.red}Unknown command. Type /help for help.${c.reset}`);
        return;
    }

    if (serverType === "web_server") {
        if (!connected || !webSocket || webSocket.readyState !== 1) {
            print(`${c.red}[Error] Not connected to api.cfat.site.${c.reset}`);
            return;
        }
        webSocket.send(JSON.stringify({ type: "chat", text: input }));
    } else {
        sendSyncplayUserChatMessage(input);
    }
    promptInput();
}

/* ─── File Sharing Dispatcher ──────────────────────────────────── */

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

    if (serverType === "web_server") {
        sendWebFile(filepath, stat);
    } else {
        sendSyncplayFile(filepath, stat);
    }
}

/* ─── Web Server File Sharing (Cloudflare Worker) ───────────────── */

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

        // 1. Broadcast file_offer to room
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
        const approxRawSent = Math.min(
            transfer.size,
            Math.round((chunkIndex / totalChunks) * transfer.size)
        );
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
        finalizeIncomingFile(transfer);
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

/* ─── Syncplay File Sharing (Over Set.playlistChange) ───────────── */

function sendSyncplayFile(filepath, stat) {
    try {
        const filename = path.basename(filepath);
        const rawBuffer = fs.readFileSync(filepath);
        const deflated = zlib.deflateRawSync(rawBuffer);
        const useCompressed = deflated.length < rawBuffer.length;
        const payloadBuffer = useCompressed ? deflated : rawBuffer;
        const totalChunks = payloadBuffer.length > 0
            ? Math.ceil(payloadBuffer.length / SYNCPLAY_FILE_SLICE)
            : 0;
        const transferId = crypto.randomBytes(4).toString("hex");

        outgoingFile = {
            backend: "syncplay",
            id: transferId,
            filename,
            size: stat.size,
            payloadBuffer,
            compressed: useCompressed,
            totalChunks,
            acceptedBy: null,
            timer: null,
        };

        sendProtocolMessage({
            t: "fm",
            id: transferId,
            n: filename,
            s: stat.size,
            z: useCompressed ? 1 : 0,
            k: totalChunks,
        });

        print(`${c.gray}Offered file ${filename} (${humanSize(stat.size)}) — waiting for acceptance…${c.reset}`);
    } catch (err) {
        print(`${c.red}Failed to prepare file transfer: ${err.message}${c.reset}`);
    }
}

function transmitSyncplayFile(transfer, recipient) {
    const payload = transfer.payloadBuffer;
    const totalChunks = transfer.totalChunks;
    let chunkIndex = 0;

    if (totalChunks === 0) {
        sendProtocolMessage({ t: "fd", to: recipient, id: transfer.id });
        print(`${c.green}✓ File sent: ${transfer.filename}${c.reset}`);
        outgoingFile = null;
        return;
    }

    function sendNextChunk() {
        if (!connected || outgoingFile !== transfer) return;

        if (chunkIndex >= totalChunks) {
            clearProgress();
            // Clear Syncplay room playlist state after transfer completes
            sendRawJson({ Set: { playlistChange: { files: [] } } });
            sendProtocolMessage({ t: "fd", to: recipient, id: transfer.id });
            print(`${c.green}✓ File sent: ${transfer.filename}${c.reset}`);
            outgoingFile = null;
            return;
        }

        const start = chunkIndex * SYNCPLAY_FILE_SLICE;
        const slice = payload.subarray(start, start + SYNCPLAY_FILE_SLICE);
        const header = `CCFILE|${JSON.stringify({
            id: transfer.id,
            to: recipient,
            i: chunkIndex,
            n: totalChunks,
        })}`;

        sendRawJson({
            Set: {
                playlistChange: {
                    files: [header, slice.toString("base64")],
                },
            },
        });

        chunkIndex++;
        const approxRawSent = Math.min(
            transfer.size,
            Math.round((chunkIndex / totalChunks) * transfer.size)
        );
        drawProgress("Sending", approxRawSent, transfer.size);

        transfer.timer = setTimeout(sendNextChunk, SYNCPLAY_CHUNK_PACE_MS);
    }

    sendNextChunk();
}

function handleIncomingSyncplayFileChunk(sender, headerStr, base64Data) {
    if (!incomingFile || incomingFile.from !== sender) return;

    let meta;
    try {
        meta = JSON.parse(headerStr.slice(7));
    } catch {
        return;
    }

    if (
        !meta ||
        meta.id !== incomingFile.id ||
        meta.to !== username ||
        !Number.isInteger(meta.i) ||
        !Number.isInteger(meta.n) ||
        meta.i < 0 ||
        meta.i >= meta.n
    ) {
        return;
    }

    if (incomingFile.totalChunks === 0) {
        incomingFile.totalChunks = meta.n;
        incomingFile.chunks = new Array(meta.n).fill(null);
    }

    if (incomingFile.chunks[meta.i] !== null) return;

    const chunkBuf = Buffer.from(String(base64Data || ""), "base64");
    incomingFile.chunks[meta.i] = chunkBuf;
    incomingFile.receivedChunks++;
    incomingFile.receivedEncodedBytes += chunkBuf.length;

    const approxRawReceived = Math.min(
        incomingFile.size,
        Math.round((incomingFile.receivedChunks / incomingFile.totalChunks) * incomingFile.size)
    );
    drawProgress("Receiving", approxRawReceived, incomingFile.size);

    if (incomingFile.receivedChunks >= incomingFile.totalChunks) {
        finalizeIncomingFile();
    }
}

function finalizeIncomingFile(explicitTransfer = null) {
    const transfer = explicitTransfer || incomingFile;
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
        fs.writeFileSync(savePath, fileBuffer);
        print(`${c.green}✓ File saved: ${savePath} (${humanSize(fileBuffer.length)})${c.reset}`);
    } catch (err) {
        print(`${c.red}Failed to save incoming file: ${err.message}${c.reset}`);
    } finally {
        incomingTransfers.delete(transfer.id);
        if (incomingFile === transfer) incomingFile = null;
    }
}

function cleanupUserTransfers(peerName) {
    for (const key of pendingTextChunks.keys()) {
        if (key.startsWith(`${peerName}:`)) {
            pendingTextChunks.delete(key);
        }
    }
    for (const [id, t] of incomingTransfers.entries()) {
        if (t.from && t.from.toLowerCase() === peerName.toLowerCase() && !t.finalized) {
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

/* ─── Progress Bar ──────────────────────────────────────────────── */

function drawProgress(label, done, total) {
    const pct    = total > 0 ? Math.min(1, done / total) : 1;
    const filled = Math.round(pct * BAR_WIDTH);
    const bar    = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const pctStr = (pct * 100).toFixed(1).padStart(5);
    process.stdout.write(
        `\r${c.cyan}${label}${c.reset} [${bar}] ${pctStr}%  ${humanSize(done)} / ${humanSize(total)}   `
    );
}

function clearProgress() {
    process.stdout.write("\r" + " ".repeat(76) + "\r");
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

function printUserList() {
    const users = Array.from(roomUsers);
    print(
        `${c.bold}Online in ${room} (${users.length}):${c.reset} ` +
        users.map((u) => (u === username ? `${c.green}${u} (you)${c.reset}` : u)).join("  ")
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

function safeFilename(name) {
    const clean = path.basename(String(name || "file").replace(/[/\\]/g, "_"));
    return clean || "file";
}
