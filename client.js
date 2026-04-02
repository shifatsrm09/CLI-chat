/**
 * cli-chat — Client (Dual TEXT fixed)
 * Terminal chat + chunked file transfer (up to ~100 MB).
 *
 * Commands:
 *   /help               — show this list
 *   /list               — show online users
 *   /send <file>        — offer a file to all users
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
    { name: "Render",    url: "wss://cli-chat-ic6w.onrender.com" },
    { name: "Mirpur",    url: "ws://your-mirpur-server:8080" },
    { name: "Localhost", url: "ws://localhost:8080" },
];
const CHUNK_SIZE   = 256 * 1024;   // 256 KB per chunk
const MAX_BACKOFF  = 30_000;       // max reconnect delay (ms)

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

/** Outgoing file waiting for accept. { buffer, filename } */
let outgoingFile = null;

/** Incoming file being reassembled. { filename, size, chunks: Buffer[] } */
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

let rl;

function startChat() {
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.setPrompt(`${c.bold}${c.green}${username}${c.reset}: `);
    rl.on("line", handleInput);

    connect();
}

function connect() {
    startProgressBar();
    ws = new WebSocket(selectedServer.url);

    ws.on("open", () => {
        finishProgressBar();
        reconnectDelay = 1000;

        ws.send(JSON.stringify({ type: "join", username }));
        rl.prompt();
    });

    ws.on("message", handleMessage);

    ws.on("close", () => {
        if (quitting) return;
        print(
            `${c.yellow}[!] Connection to ${selectedServer.name} lost. Reconnecting in ${reconnectDelay / 1000}s…${c.reset}`
        );
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_BACKOFF);
    });

    ws.on("error", () => {
        // Errors are followed by 'close', handled above
    });
}

/* ─── Input handler ─────────────────────────────────────────────── */

function handleInput(line) {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    /* /quit */
    if (input === "/quit" || input === "/exit") {
        quitting = true;
        print(`${c.gray}Goodbye.${c.reset}`);
        ws.close();
        rl.close();
        process.exit(0);
    }

    /* /help */
    if (input === "/help") {
        print(
            `\n${c.bold}Commands:${c.reset}\n` +
            `  ${c.cyan}/list${c.reset}              — who is online\n` +
            `  ${c.cyan}/send <file>${c.reset}       — offer a file to the room\n` +
            `  ${c.cyan}/w <user> <msg>${c.reset}    — private (whisper) message\n` +
            `  ${c.cyan}/quit${c.reset}              — disconnect and exit\n`
        );
        rl.prompt();
        return;
    }

    /* /list */
    if (input === "/list") {
        ws.send(JSON.stringify({ type: "list" }));
        return;
    }

    /* /send <filepath> */
    if (input.startsWith("/send ")) {
        const filepath = input.slice(6).trim();
        sendFile(filepath);
        return;
    }

    /* /w <user> <message> */
    if (input.startsWith("/w ")) {
        const parts   = input.slice(3).trim().split(" ");
        const to      = parts.shift();
        const content = parts.join(" ");
        if (!to || !content) {
            print(`${c.red}Usage: /w <username> <message>${c.reset}`);
            rl.prompt();
            return;
        }
        ws.send(JSON.stringify({ type: "whisper", to, content }));
        return;
    }

    /* Unknown command */
    if (input.startsWith("/")) {
        print(`${c.red}Unknown command. Type /help for help.${c.reset}`);
        rl.prompt();
        return;
    }

    /* Regular chat message */
    ws.send(JSON.stringify({ type: "message", from: username, content: input }));
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

        /* ── Incoming file offer ── */
        case "file-meta":
            rl.question(
                `\n${c.yellow}${msg.from} wants to send ${c.bold}${msg.filename}${c.reset}${c.yellow} ` +
                `(${humanSize(msg.size)}). Accept? [y/N]: ${c.reset}`,
                (answer) => {
                    if (answer.toLowerCase() === "y") {
                        incomingFile = { filename: msg.filename, size: msg.size, chunks: [] };
                        ws.send(JSON.stringify({ type: "file-accept", from: msg.from }));
                        print(`${c.gray}Receiving ${msg.filename}…${c.reset}`);
                    } else {
                        ws.send(JSON.stringify({ type: "file-reject", from: msg.from }));
                    }
                    rl.prompt();
                }
            );
            break;

        /* ── Recipient accepted our offer — start sending ── */
        case "file-accept":
            print(`${c.green}${msg.by} accepted the file. Sending…${c.reset}`);
            if (outgoingFile) {
                transmitFile(outgoingFile.buffer, outgoingFile.filename);
            }
            break;

        /* ── Recipient rejected ── */
        case "file-reject":
            print(`${c.yellow}${msg.by} declined the file.${c.reset}`);
            outgoingFile = null;
            break;

        /* ── Incoming chunk ── */
        case "file-chunk":
            if (incomingFile) {
                const chunkBuf = Buffer.from(msg.data, "base64");
                incomingFile.chunks.push(chunkBuf);

                const received = incomingFile.chunks.reduce((s, b) => s + b.length, 0);
                drawProgress("Receiving", received, incomingFile.size);
            }
            break;

        /* ── Transfer complete ── */
        case "file-done":
            if (incomingFile) {
                const full = Buffer.concat(incomingFile.chunks);
                const savePath = incomingFile.filename; // overwrite existing file
                fs.writeFileSync(savePath, full);
                clearProgress();
                print(`${c.green}✓ Saved: ${savePath} (${humanSize(full.length)})${c.reset}`);
                incomingFile = null;
            }
            break;

        /* ── Sender cancelled mid-transfer ── */
        case "file-cancel":
            if (incomingFile) {
                clearProgress();
                print(`${c.red}Transfer cancelled by ${msg.from}.${c.reset}`);
                incomingFile = null;
            }
            break;
    }

    rl.prompt(true);
}

/* ─── File sending ──────────────────────────────────────────────── */

function sendFile(filepath) {
    if (!fs.existsSync(filepath)) {
        print(`${c.red}File not found: ${filepath}${c.reset}`);
        rl.prompt();
        return;
    }

    const stat     = fs.statSync(filepath);
    const filename = path.basename(filepath);

    // Warn for very large files but don't block
    if (stat.size > 200 * 1024 * 1024) {
        print(`${c.yellow}Warning: file is ${humanSize(stat.size)}. Large transfers may be slow.${c.reset}`);
    }

    const buffer = fs.readFileSync(filepath);
    outgoingFile = { buffer, filename };

    ws.send(JSON.stringify({ type: "file-meta", from: username, filename, size: stat.size }));
    print(`${c.gray}Offered ${filename} (${humanSize(stat.size)}) — waiting for acceptance…${c.reset}`);
}

/** Send a file buffer as sequential base64 chunks. */
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
            rl.prompt(true);
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

        // Yield to event loop so socket buffer can drain
        setImmediate(sendNext);
    }

    sendNext();
}

/* ─── Progress bar ──────────────────────────────────────────────── */

const BAR_WIDTH = 24;

function drawProgress(label, done, total) {
    const pct   = Math.min(1, done / total);
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

/* ─── Connection progress bar ───────────────────────────────────── */

let connectTimer;
let connectProgress = 0;

const CONNECT_MAX      = 97;
const CONNECT_DURATION = 70000;
const CONNECT_STEP     = CONNECT_DURATION / CONNECT_MAX;

function startProgressBar() {
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

function finishProgressBar() {
    clearInterval(connectTimer);

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
    rl.prompt(true);
}

function humanSize(bytes) {
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function safeFilename(name) {
    if (!fs.existsSync(name)) return name;
    const ext  = path.extname(name);
    const base = path.basename(name, ext);
    let   i    = 1;
    while (fs.existsSync(`${base}(${i})${ext}`)) i++;
    return `${base}(${i})${ext}`;
}
