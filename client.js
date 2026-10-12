/**
 * cli-chat — Serverless Terminal Client (Syncplay Protocol)
 * Real-time terminal chat, room hosting/joining, auto-chunked messaging (>150 chars),
 * and file sharing over Syncplay (syncplay.pl:8995).
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

const STEALTH = process.argv.includes("-s");

/* ─── Config ────────────────────────────────────────────────────── */

const SYNCPLAY_HOST          = getArgValue("--host") || "syncplay.pl";
const SYNCPLAY_PORT          = Number(getArgValue("--port")) || 8995;
const DEFAULT_MAX_CHAT_LEN   = 150;
const MAX_USERNAME_LEN       = 16;
const MAX_ROOM_NAME_LEN      = 35;
const CHUNK_ENVELOPE_RESERVE = 52;       // reserves space for CC|{"t":"c","m":"xxxx","i":999,"n":999,"d":""}
const MAX_TEXT_CHUNKS        = 256;      // up to ~25 KB per text message
const CHUNK_TIMEOUT_MS       = 20_000;   // expire incomplete chunk assemblies
const CHAT_CHUNK_PACE_MS     = 25;       // pacing between 150-char chat chunks
const FILE_SLICE_BYTES       = 7200;     // 7200 bytes = 9600 base64 chars (< 10000 Syncplay limit)
const FILE_CHUNK_PACE_MS     = 45;       // pacing between file chunks
const HEARTBEAT_MS           = 1500;     // Syncplay State keepalive interval
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

let username         = getArgValue("--user") || "";
let room             = getArgValue("--room") || "";
let maxChatLength    = DEFAULT_MAX_CHAT_LEN;
let rawSocket        = null;
let tlsSocket        = null;
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

/** Online users in the current Syncplay room */
const roomUsers = new Set();

/** Pending incoming text/control chunk assemblies: key (sender:msgId) -> { total, received, parts, createdAt } */
const pendingTextChunks = new Map();
const completedTextKeys = new Set();

/** Outgoing transfer waiting for accept or currently sending */
let outgoingFile = null;

/** Incoming transfer being reassembled */
let incomingFile = null;

/** Outgoing chat queue so multi-chunk messages are paced cleanly */
const chatSendQueue = [];
let chatQueueTimer  = null;

/* ─── Boot: ask username, host/join room, then connect ─────────── */

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
            const mode = await selectRoomAction();
            if (mode === "host") {
                const customRoom = await askQuestion(
                    `${c.bold}Room name to host ${c.gray}(press Enter for random code)${c.reset}${c.bold}: ${c.reset}`
                );
                room = sanitizeRoomName(customRoom) || generateRoomCode();
                console.log(
                    `${c.gray}Hosting room:${c.reset} ${c.bold}${c.cyan}${room}${c.reset} ` +
                    `${c.gray}(share this room name with others to join)${c.reset}`
                );
            } else {
                const joinName = await askQuestion(`${c.bold}Enter room name to join: ${c.reset}`);
                room = sanitizeRoomName(joinName);
                if (!room) {
                    console.log(`${c.red}Room name cannot be empty.${c.reset}`);
                    process.exit(1);
                }
                console.log(`${c.gray}Joining room:${c.reset} ${c.bold}${c.cyan}${room}${c.reset}`);
            }
        } else {
            room = sanitizeRoomName(room);
        }
    } catch {
        process.exit(1);
    }

    console.log(
        `${c.gray}Syncplay server:${c.reset} ${c.bold}${SYNCPLAY_HOST}:${SYNCPLAY_PORT}${c.reset} ` +
        `${c.gray}| User:${c.reset} ${c.bold}${username}${c.reset} ` +
        `${c.gray}| Room:${c.reset} ${c.bold}${room}${c.reset}`
    );

    startChat();
})();

function getArgValue(flag) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1];
    }
    return null;
}

function sanitizeUsername(name) {
    return String(name || "").trim().slice(0, MAX_USERNAME_LEN);
}

function sanitizeRoomName(name) {
    return String(name || "").trim().slice(0, MAX_ROOM_NAME_LEN);
}

function generateRoomCode() {
    const num = crypto.randomInt(1000, 9999);
    return `CLI-${num}`;
}

function showHeader() {
    if (process.stdout.isTTY) console.clear();
    console.log(
        `\n${c.bold}${c.cyan}  cli-chat${c.reset}  ${c.gray}syncplay terminal messenger${c.reset}\n` +
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

/* ─── Host / Join Room Selector ────────────────────────────────── */

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

/* ─── Chat readline + Syncplay Connection ──────────────────────── */

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

function connect(isReconnect = false) {
    if (quitting) return;
    cleanupConnection();

    const attempt = {
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
        handleConnectionDrop(attempt, "Connection timed out");
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
}

/* ─── Syncplay Frame Router ────────────────────────────────────── */

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
                    handleIncomingFileChunk(pc.user, pc.files[0], pc.files[1]);
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
        if (sender === username) return; // ignore our own echo
        handleIncomingChat(sender, message);
        return;
    }

    // 6. Server Error
    if (root.Error && typeof root.Error === "object") {
        const errMsg = root.Error.message || "Unknown server error";
        print(`${c.red}[Error] ${errMsg}${c.reset}`);
    }
}

/* ─── 150-Char Message Transfer & Auto-Chunking System ─────────── */

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

/**
 * Sends a structured cli-chat protocol object over Syncplay's 150-char Chat channel.
 * Automatically splits payloads > maxChatLength (150 chars) into base64 chunk frames.
 */
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

/**
 * Sends a public chat message.
 * Short messages (<= 150 chars) are sent directly as native Syncplay Chat;
 * longer messages (> 150 chars) are automatically chunked via CC| envelopes.
 */
function sendUserChatMessage(text) {
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

function handleIncomingChat(sender, msg) {
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

    handleProtocolPayload(sender, obj);
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
        handleProtocolPayload(sender, decodedObj);
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

function handleProtocolPayload(sender, msg) {
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
            transmitFile(outgoingFile, sender);
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
            sendProtocolMessage({ t: "fc", id: outgoingFile.id });
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
        pendingListPrint = true;
        sendRawJson({ List: null });
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
        sendRawJson({ Set: { room: { name: room } } });
        sendRawJson({ List: null });
        print(`${c.gray}[System] Switched to room:${c.reset} ${c.bold}${c.cyan}${room}${c.reset}`);
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
        if (sendProtocolMessage({ t: "w", to, c: content })) {
            print(`${c.gray}[PM → ${to}] ${content}${c.reset}`);
        }
        return;
    }

    if (input.startsWith("/")) {
        print(`${c.red}Unknown command. Type /help for help.${c.reset}`);
        return;
    }

    sendUserChatMessage(input);
    promptInput();
}

/* ─── File Sharing (Over Syncplay Protocol) ────────────────────── */

function sendFile(filepath) {
    if (!connected) {
        print(`${c.red}[Error] Not connected to Syncplay server.${c.reset}`);
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

    try {
        const filename = path.basename(filepath);
        const rawBuffer = fs.readFileSync(filepath);
        const deflated = zlib.deflateRawSync(rawBuffer);
        const useCompressed = deflated.length < rawBuffer.length;
        const payloadBuffer = useCompressed ? deflated : rawBuffer;
        const totalChunks = payloadBuffer.length > 0
            ? Math.ceil(payloadBuffer.length / FILE_SLICE_BYTES)
            : 0;
        const transferId = crypto.randomBytes(4).toString("hex");

        outgoingFile = {
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

function transmitFile(transfer, recipient) {
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

        const start = chunkIndex * FILE_SLICE_BYTES;
        const slice = payload.subarray(start, start + FILE_SLICE_BYTES);
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

        transfer.timer = setTimeout(sendNextChunk, FILE_CHUNK_PACE_MS);
    }

    sendNextChunk();
}

function handleIncomingFileChunk(sender, headerStr, base64Data) {
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

function finalizeIncomingFile() {
    if (!incomingFile) return;
    const transfer = incomingFile;
    incomingFile = null;

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
    }
}

function cleanupUserTransfers(peerName) {
    for (const key of pendingTextChunks.keys()) {
        if (key.startsWith(`${peerName}:`)) {
            pendingTextChunks.delete(key);
        }
    }
    if (incomingFile && incomingFile.from === peerName) {
        clearProgress();
        print(`${c.red}Transfer interrupted: ${peerName} left the room.${c.reset}`);
        incomingFile = null;
    }
    if (outgoingFile && outgoingFile.acceptedBy === peerName) {
        if (outgoingFile.timer) clearTimeout(outgoingFile.timer);
        clearProgress();
        print(`${c.red}Transfer interrupted: ${peerName} left the room.${c.reset}`);
        outgoingFile = null;
    }
}

/* ─── Progress bar ──────────────────────────────────────────────── */

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
    if (!fs.existsSync(name)) return name;
    const ext  = path.extname(name);
    const base = path.basename(name, ext);
    let i = 1;
    while (fs.existsSync(`${base}(${i})${ext}`)) i++;
    return `${base}(${i})${ext}`;
}
