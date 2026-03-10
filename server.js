/**
 * cli-chat — Server
 * Robust WebSocket chat + chunked file transfer for small developer groups.
 */

"use strict";

const WebSocket = require("ws");

/* ─── Config ────────────────────────────────────────────────────── */

const PORT             = process.env.PORT || 8080;
const MAX_CLIENTS      = 5;
const MAX_MSG_BYTES    = 16 * 1024;        // 16 KB cap on JSON frames
const HEARTBEAT_MS     = 30_000;           // ping interval
const USERNAME_RE      = /^[a-zA-Z0-9_\-]{1,20}$/;

/* ─── State ─────────────────────────────────────────────────────── */

/** @type {Map<string, WebSocket>} username → socket */
const clients = new Map();

/**
 * Active file offers waiting for accept/reject.
 * senderName → { filename, size, acceptedBy: string|null }
 */
const pendingTransfers = new Map();

/* ─── Server bootstrap ──────────────────────────────────────────── */

const wss = new WebSocket.Server({ port: PORT, host: "0.0.0.0" });

log(`Server running on port ${PORT}  (max ${MAX_CLIENTS} users)`);

wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;

    if (clients.size >= MAX_CLIENTS) {
        safeSend(ws, { type: "error", content: "Server full — max 5 users allowed." });
        ws.close();
        log(`Rejected connection from ${ip}: server full`);
        return;
    }

    ws.username = null;
    ws.joined   = false;
    ws.isAlive  = true;

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw, isBinary) => onMessage(ws, raw, isBinary));
    ws.on("close",   () => onClose(ws));
    ws.on("error",   (err) => log(`[ERR] ${ws.username ?? ip}: ${err.message}`));
});

/* ─── Heartbeat ─────────────────────────────────────────────────── */

const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            log(`Terminating stale connection: ${ws.username ?? "unknown"}`);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeatTimer));

/* ─── Message router ────────────────────────────────────────────── */

function onMessage(ws, raw, isBinary) {

    // Guard oversized frames
    if (raw.length > MAX_MSG_BYTES) {
        safeSend(ws, { type: "error", content: "Message frame too large." });
        return;
    }

    if (isBinary) {
        // Legacy raw binary — forward to everyone else (fallback path)
        relay(ws, raw, true);
        return;
    }

    let data;
    try {
        data = JSON.parse(raw.toString());
    } catch {
        return; // silently drop malformed frames
    }

    // All non-join messages require an authenticated session
    if (data.type !== "join" && !ws.joined) {
        safeSend(ws, { type: "error", content: "Not authenticated." });
        return;
    }

    switch (data.type) {

        /* ── Auth ── */
        case "join": {
            const name = String(data.username ?? "").trim();

            if (!USERNAME_RE.test(name)) {
                safeSend(ws, { type: "error", content: "Invalid username. 1–20 chars: letters, digits, _ or -" });
                ws.close();
                return;
            }
            if (clients.has(name)) {
                safeSend(ws, { type: "error", content: `Username "${name}" is already taken.` });
                ws.close();
                return;
            }

            ws.username = name;
            ws.joined   = true;
            clients.set(name, ws);

            log(`JOIN  ${name}`);

            safeSend(ws, { type: "system", content: `Welcome, ${name}! Type /help for commands.` });
            broadcast({ type: "system", content: `${name} joined the chat` }, ws);
            pushUserList();
            break;
        }

        /* ── Chat message ── */
        case "message": {
            const content = String(data.content ?? "").substring(0, 2000);
            log(`MSG   ${ws.username}: ${content.substring(0, 80)}`);
            broadcast({ type: "message", from: ws.username, content }, ws);
            break;
        }

        /* ── Private message ── */
        case "whisper": {
            const target = clients.get(data.to);
            if (!target) {
                safeSend(ws, { type: "error", content: `User "${data.to}" not found.` });
                return;
            }
            const content = String(data.content ?? "").substring(0, 2000);
            safeSend(target, { type: "whisper", from: ws.username, content });
            safeSend(ws,     { type: "whisper-echo", to: data.to, content });
            break;
        }

        /* ── Who's online ── */
        case "list":
            safeSend(ws, { type: "user-list", users: Array.from(clients.keys()) });
            break;

        /* ── File offer ── */
        case "file-meta": {
            const filename = String(data.filename ?? "").replace(/[/\\]/g, "_"); // sanitise
            const size     = Number(data.size) || 0;

            pendingTransfers.set(ws.username, { filename, size, acceptedBy: null });

            broadcast({
                type: "file-meta",
                from: ws.username,
                filename,
                size,
            }, ws);

            log(`FILE  ${ws.username} → all: ${filename} (${humanSize(size)})`);
            break;
        }

        /* ── Recipient accepts ── */
        case "file-accept": {
            const senderName = String(data.from ?? "");
            const senderWs   = clients.get(senderName);
            const transfer   = pendingTransfers.get(senderName);

            if (!senderWs || !transfer) {
                safeSend(ws, { type: "error", content: "Transfer no longer available." });
                return;
            }

            // Only one recipient at a time
            if (transfer.acceptedBy) {
                safeSend(ws, { type: "error", content: "Someone else already accepted that file." });
                return;
            }

            transfer.acceptedBy = ws.username;
            safeSend(senderWs, { type: "file-accept", by: ws.username });
            log(`FILE  ${ws.username} accepted file from ${senderName}`);
            break;
        }

        /* ── Recipient rejects ── */
        case "file-reject": {
            const senderName = String(data.from ?? "");
            const senderWs   = clients.get(senderName);

            if (senderWs) {
                safeSend(senderWs, { type: "file-reject", by: ws.username });
            }
            pendingTransfers.delete(senderName);
            log(`FILE  ${ws.username} rejected file from ${senderName}`);
            break;
        }

        /* ── File chunk (base64 JSON) ── */
        case "file-chunk": {
            const transfer = pendingTransfers.get(ws.username);
            if (!transfer?.acceptedBy) return;

            const recipientWs = clients.get(transfer.acceptedBy);
            if (recipientWs?.readyState === WebSocket.OPEN) {
                // Forward the chunk as-is
                recipientWs.send(JSON.stringify(data));
            }
            break;
        }

        /* ── Transfer complete ── */
        case "file-done": {
            const transfer = pendingTransfers.get(ws.username);
            if (!transfer?.acceptedBy) return;

            const recipientWs = clients.get(transfer.acceptedBy);
            if (recipientWs?.readyState === WebSocket.OPEN) {
                safeSend(recipientWs, {
                    type:     "file-done",
                    from:     ws.username,
                    filename: transfer.filename,
                    size:     transfer.size,
                });
            }
            pendingTransfers.delete(ws.username);
            log(`FILE  ${ws.username} → ${transfer.acceptedBy}: ${transfer.filename} complete`);
            break;
        }

        /* ── Transfer cancelled by sender ── */
        case "file-cancel": {
            const transfer = pendingTransfers.get(ws.username);
            if (transfer?.acceptedBy) {
                const recipientWs = clients.get(transfer.acceptedBy);
                if (recipientWs) {
                    safeSend(recipientWs, { type: "file-cancel", from: ws.username });
                }
            }
            pendingTransfers.delete(ws.username);
            break;
        }

        default:
            // Unknown type — silently ignore
    }
}

/* ─── Disconnect ────────────────────────────────────────────────── */

function onClose(ws) {
    if (ws.username) {
        clients.delete(ws.username);
        // Cancel any in-progress transfer they owned
        const transfer = pendingTransfers.get(ws.username);
        if (transfer?.acceptedBy) {
            const recipientWs = clients.get(transfer.acceptedBy);
            if (recipientWs) {
                safeSend(recipientWs, { type: "file-cancel", from: ws.username });
            }
        }
        pendingTransfers.delete(ws.username);
    }

    if (ws.joined) {
        log(`LEAVE ${ws.username}`);
        broadcast({ type: "system", content: `${ws.username} left the chat` });
        pushUserList();
    }
}

/* ─── Helpers ───────────────────────────────────────────────────── */

/** Send JSON to a single socket, swallowing errors. */
function safeSend(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

/** Broadcast JSON (or binary) to all clients except optional sender. */
function broadcast(obj, sender = null) {
    const frame = typeof obj === "string" ? obj : JSON.stringify(obj);
    clients.forEach((ws) => {
        if (ws !== sender && ws.readyState === WebSocket.OPEN) {
            ws.send(frame);
        }
    });
}

/** Forward a raw binary buffer to all clients except sender. */
function relay(sender, buffer, isBinary) {
    clients.forEach((ws) => {
        if (ws !== sender && ws.readyState === WebSocket.OPEN) {
            ws.send(buffer, { binary: isBinary });
        }
    });
}

/** Push updated user list to every connected client. */
function pushUserList() {
    const msg = JSON.stringify({ type: "user-list", users: Array.from(clients.keys()) });
    clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
}

function humanSize(bytes) {
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function log(msg) {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}
