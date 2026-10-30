const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// MIME types
const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// In-memory room manager for local development
// Map of roomName -> Set of { ws, username }
const rooms = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Config endpoint
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "chat.cfat.site (Local Dev)",
        wsUrl: "", // Empty string means use same host ws://
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // Static file serving
  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    }
  });
});

// Setup WebSocket server
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const room = (url.searchParams.get("room") || "DEFAULT").toUpperCase().trim();
  const username = (url.searchParams.get("user") || "Guest").trim().slice(0, 32);

  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }

  const roomSet = rooms.get(room);
  const clientInfo = { ws, username };
  roomSet.add(clientInfo);

  const currentUsers = Array.from(roomSet).map((c) => c.username);

  // Send state to joined user
  ws.send(
    JSON.stringify({
      type: "room_state",
      room,
      user: username,
      users: currentUsers,
      timestamp: Date.now(),
    })
  );

  // Notify other users
  broadcast(
    room,
    {
      type: "user_joined",
      user: username,
      users: currentUsers,
      timestamp: Date.now(),
    },
    ws
  );

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "chat" && typeof data.text === "string") {
        const text = data.text.trim().slice(0, 2000);
        if (!text) return;

        broadcast(room, {
          type: "chat",
          id: Math.random().toString(36).substring(2, 9),
          user: username,
          message: text,
          timestamp: Date.now(),
        });
      } else if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    } catch (e) {
      console.error("Local WS parse error:", e);
    }
  });

  const cleanup = () => {
    roomSet.delete(clientInfo);
    if (roomSet.size === 0) {
      rooms.delete(room);
    } else {
      const remainingUsers = Array.from(roomSet).map((c) => c.username);
      broadcast(room, {
        type: "user_left",
        user: username,
        users: remainingUsers,
        timestamp: Date.now(),
      });
    }
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

function broadcast(roomName, dataObj, excludeWs = null) {
  const roomSet = rooms.get(roomName);
  if (!roomSet) return;
  const serialized = JSON.stringify(dataObj);
  for (const client of roomSet) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      try {
        client.ws.send(serialized);
      } catch (_) {}
    }
  }
}

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Chat Web App & Local WebSocket Server Running!`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   Try opening two tabs to test room chat locally!`);
  console.log(`======================================================\n`);
});
