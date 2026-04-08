/**
* cli-chat — Server
* Robust WebSocket chat + chunked file/folder transfer for small developer groups.
*/

"use strict";

const WebSocket = require("ws");

/* ─── Config ────────────────────────────────────────────────────── */

const PORT             = process.env.PORT || 8080;
const MAX_CLIENTS      = 5;
const MAX_MSG_BYTES    = 512 * 1024;       // allow chunked transfer frames comfortably
const HEARTBEAT_MS     = 30_000;
const USERNAME_RE      = /^[a-zA-Z0-9_\-]{1,20}$/;

/* ─── State ─────────────────────────────────────────────────────── */

/** @type {Map<string, WebSocket>} username → socket */
const clients = new Map();

/**
* Active file offers waiting for accept/reject.
* senderName → { filename, originalName, kind, size, acceptedBy: string|null }
*/
const pendingTransfers = new Map();

/* ─── Server bootstrap ──────────────────────────────────────────── */

const wss = new WebSocket.Server({ port: PORT, host: "0.0.0.0" });

log(` ✅ Server running on port ${PORT} (max ${MAX_CLIENTS} users)`);

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
   if (raw.length > MAX_MSG_BYTES) {
       safeSend(ws, { type: "error", content: "Message frame too large." });
       return;
   }

   if (isBinary) {
       relay(ws, raw, true);
       return;
   }

   let data;
   try {
       data = JSON.parse(raw.toString());
   } catch {
       return;
   }

   if (data.type !== "join" && !ws.joined) {
       safeSend(ws, { type: "error", content: "Not authenticated." });
       return;
   }

   switch (data.type) {
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

       case "message": {
           const content = String(data.content ?? "").substring(0, 2000);
           log(`MSG   ${ws.username}: ${content.substring(0, 80)}`);
           broadcast({ type: "message", from: ws.username, content }, ws);
           break;
       }

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

       case "list":
           safeSend(ws, { type: "user-list", users: Array.from(clients.keys()) });
           break;

       case "file-meta": {
           const filename = String(data.filename ?? "").replace(/[/\\]/g, "_");
           const originalName = String(data.originalName ?? filename).replace(/[/\\]/g, "_");
           const kind = data.kind === "directory" ? "directory" : "file";
           const size = Number(data.size) || 0;

           pendingTransfers.set(ws.username, { filename, originalName, kind, size, acceptedBy: null });

           broadcast({
               type: "file-meta",
               from: ws.username,
               filename,
               originalName,
               kind,
               size,
           }, ws);

           log(`FILE  ${ws.username} → all: ${kind} ${originalName} (${humanSize(size)})`);
           break;
       }

       case "file-accept": {
           const senderName = String(data.from ?? "");
           const senderWs   = clients.get(senderName);
           const transfer   = pendingTransfers.get(senderName);

           if (!senderWs || !transfer) {
               safeSend(ws, { type: "error", content: "Transfer no longer available." });
               return;
           }

           if (transfer.acceptedBy) {
               safeSend(ws, { type: "error", content: "Someone else already accepted that transfer." });
               return;
           }

           transfer.acceptedBy = ws.username;
           safeSend(senderWs, { type: "file-accept", by: ws.username, kind: transfer.kind, originalName: transfer.originalName });
           log(`FILE  ${ws.username} accepted ${transfer.kind} from ${senderName}`);
           break;
       }

       case "file-reject": {
           const senderName = String(data.from ?? "");
           const senderWs   = clients.get(senderName);

           if (senderWs) {
               safeSend(senderWs, { type: "file-reject", by: ws.username });
           }
           pendingTransfers.delete(senderName);
           log(`FILE  ${ws.username} rejected transfer from ${senderName}`);
           break;
       }

       case "file-chunk": {
           const transfer = pendingTransfers.get(ws.username);
           if (!transfer?.acceptedBy) return;

           const recipientWs = clients.get(transfer.acceptedBy);
           if (recipientWs?.readyState === WebSocket.OPEN) {
               recipientWs.send(JSON.stringify(data));
           }
           break;
       }

       case "file-done": {
           const transfer = pendingTransfers.get(ws.username);
           if (!transfer?.acceptedBy) return;

           const recipientWs = clients.get(transfer.acceptedBy);
           if (recipientWs?.readyState === WebSocket.OPEN) {
               safeSend(recipientWs, {
                   type: "file-done",
                   from: ws.username,
                   filename: transfer.filename,
                   originalName: transfer.originalName,
                   kind: transfer.kind,
                   size: transfer.size,
               });
           }
           pendingTransfers.delete(ws.username);
           log(`FILE  ${ws.username} → ${transfer.acceptedBy}: ${transfer.kind} ${transfer.originalName} complete`);
           break;
       }

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
   }
}

/* ─── Disconnect ────────────────────────────────────────────────── */

function onClose(ws) {
   if (ws.username) {
       clients.delete(ws.username);
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

function safeSend(ws, obj) {
   if (ws.readyState === WebSocket.OPEN) {
       ws.send(JSON.stringify(obj));
   }
}

function broadcast(obj, sender = null) {
   const frame = typeof obj === "string" ? obj : JSON.stringify(obj);
   clients.forEach((ws) => {
       if (ws !== sender && ws.readyState === WebSocket.OPEN) {
           ws.send(frame);
       }
   });
}

function relay(sender, buffer, isBinary) {
   clients.forEach((ws) => {
       if (ws !== sender && ws.readyState === WebSocket.OPEN) {
           ws.send(buffer, { binary: isBinary });
       }
   });
}

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

