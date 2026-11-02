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
  ".woff2": "font/woff2",
};

// In-memory room manager for local development
// Map of roomName -> { metadata: { createdAt, game, host }, clients: Set<{ ws, username, role, game, joinedAt, msgCount, windowStart }> }
const rooms = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Health check endpoint
  if (url.pathname === "/health" || url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "healthy",
          service: "api.cfat.site (Local Dev)",
          engine: "Node.js WebSocket Coordinator",
          version: "2.0.0",
          features: ["edge-websockets", "targeted-messaging", "rate-limiting", "multi-game-coordination", "poker-v2"],
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // 2. Platform Config endpoint
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "ok",
          service: "api.cfat.site (Local Dev)",
          version: "2.0.0",
          domain: "api.cfat.site",
          wsUrl: `ws://${req.headers.host}/ws`,
          supportedGames: ["poker", "chat"],
          maxRoomPlayers: 16,
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // 3. Supported Games Catalog endpoint
  if (url.pathname === "/api/games") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "ok",
          games: [
            {
              id: "poker",
              name: "Texas Hold'em Poker",
              maxPlayers: 8,
              roomPrefix: "POKER-",
              defaultBuyIn: 1000,
              defaultBlinds: [10, 20],
              turnTimerSeconds: 25,
            },
            {
              id: "chat",
              name: "Real-Time Room Chat",
              maxPlayers: 100,
              roomPrefix: "CHAT-",
            },
          ],
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // 4. API Poker Config endpoint
  if (url.pathname === "/api/poker" || url.pathname === "/api/poker-config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "ok",
          game: "poker",
          service: "api.cfat.site (Local Dev Poker Coordinator)",
          wsUrl: `ws://${req.headers.host}/ws`,
          maxPlayers: 8,
          defaultBuyIn: 1000,
          defaultBlinds: [10, 20],
          turnTimeSeconds: 25,
          allowedPresets: [
            { name: "Micro Stakes", buyIn: 500, blinds: [5, 10] },
            { name: "Standard Stakes", buyIn: 1000, blinds: [10, 20] },
            { name: "High Stakes", buyIn: 5000, blinds: [50, 100] },
          ],
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // 5. Room Creation Generator endpoint
  if (url.pathname === "/api/rooms/create") {
    const gameType = (url.searchParams.get("game") || "POKER").toUpperCase();
    const prefix = gameType === "CHAT" ? "CHAT" : "POKER";
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const roomCode = `${prefix}-${randomNum}`;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "ok",
          room: roomCode,
          game: gameType.toLowerCase(),
          wsUrl: `ws://${req.headers.host}/ws?room=${roomCode}`,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // 6. Room Info Inspector endpoint
  if (url.pathname === "/api/rooms/info") {
    const roomName = (url.searchParams.get("room") || "").toUpperCase().trim();
    const roomData = rooms.get(roomName);

    if (!roomData) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_found", room: roomName, userCount: 0, users: [] }));
      return;
    }

    const activeUsers = Array.from(roomData.clients).map((c) => ({
      username: c.username,
      role: c.role,
      joinedAt: c.joinedAt,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        room: roomName,
        userCount: roomData.clients.size,
        users: activeUsers,
        game: roomData.metadata.game,
        createdAt: roomData.metadata.createdAt,
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
  const room = (url.searchParams.get("room") || "LOBBY-1").toUpperCase().trim().slice(0, 32);
  const rawUser = (url.searchParams.get("user") || "Guest").trim();
  const username = sanitizeUsername(rawUser);
  const game = (url.searchParams.get("game") || (room.startsWith("POKER-") ? "poker" : "chat")).toLowerCase();
  const role = (url.searchParams.get("role") || "player").toLowerCase();

  if (!rooms.has(room)) {
    rooms.set(room, {
      metadata: { createdAt: Date.now(), game, host: username },
      clients: new Set(),
    });
  }

  const roomData = rooms.get(room);
  const now = Date.now();

  // Prune any existing session with the same username in this room
  for (const existing of roomData.clients) {
    if (existing.username.toLowerCase() === username.toLowerCase()) {
      try {
        existing.ws.send(JSON.stringify({ type: "system_notice", message: "Duplicate session pruned" }));
        existing.ws.close(1000, "Reconnected elsewhere");
      } catch (_) {}
      roomData.clients.delete(existing);
    }
  }

  const clientInfo = {
    ws,
    username,
    room,
    game,
    role,
    joinedAt: now,
    msgCount: 0,
    windowStart: now,
  };
  roomData.clients.add(clientInfo);

  if (!roomData.metadata.host) {
    roomData.metadata.host = username;
  }

  const currentUsers = Array.from(roomData.clients).map((c) => c.username);

  // Send state to joined user
  ws.send(
    JSON.stringify({
      type: "room_state",
      room,
      user: username,
      users: currentUsers,
      game,
      role,
      host: roomData.metadata.host,
      timestamp: now,
    })
  );

  // Notify other users
  broadcast(
    room,
    {
      type: "user_joined",
      user: username,
      users: currentUsers,
      game,
      timestamp: now,
    },
    ws
  );

  ws.on("message", (raw) => {
    try {
      const rawStr = raw.toString();
      if (rawStr.length > 65536) {
        ws.send(JSON.stringify({ type: "error", error: "Payload exceeds 64KB" }));
        return;
      }

      // Rate limit: max 75 msgs / 5 sec
      const curTime = Date.now();
      if (curTime - clientInfo.windowStart > 5000) {
        clientInfo.windowStart = curTime;
        clientInfo.msgCount = 0;
      }
      clientInfo.msgCount++;
      if (clientInfo.msgCount > 75) {
        ws.send(JSON.stringify({ type: "error", code: "RATE_LIMITED", error: "Rate limit exceeded" }));
        return;
      }

      const data = JSON.parse(rawStr);

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        return;
      }

      if (data.type === "chat" && typeof data.text === "string") {
        const text = data.text.trim().slice(0, 1000);
        if (!text) return;

        broadcast(room, {
          type: "chat",
          id: Math.random().toString(36).substring(2, 9),
          user: username,
          message: text,
          timestamp: Date.now(),
        });
        return;
      }

      if (data.type === "poker" || data.type === "game" || data.type === "action") {
        const msg = {
          ...data,
          fromUser: username,
          timestamp: Date.now(),
        };

        if (data.action === "claim_host" && data.newHost) {
          roomData.metadata.host = data.newHost;
        }

        const target = data.targetUser || data.to;
        if (target) {
          sendToUser(room, target, msg);
        } else {
          broadcast(room, msg, data.excludeSelf ? ws : null);
        }
        return;
      }

      if (data.type === "get_room_state") {
        ws.send(
          JSON.stringify({
            type: "room_state",
            room,
            user: username,
            users: Array.from(roomData.clients).map((c) => c.username),
            game: roomData.metadata.game,
            host: roomData.metadata.host,
            timestamp: Date.now(),
          })
        );
      }
    } catch (e) {
      console.error("Local WS parse error:", e);
      ws.send(JSON.stringify({ type: "error", error: "Malformed JSON" }));
    }
  });

  const cleanup = () => {
    roomData.clients.delete(clientInfo);
    if (roomData.clients.size === 0) {
      rooms.delete(room);
    } else {
      const remainingUsers = Array.from(roomData.clients).map((c) => c.username);
      if (roomData.metadata.host === username) {
        roomData.metadata.host = remainingUsers[0] || null;
      }
      broadcast(room, {
        type: "user_left",
        user: username,
        users: remainingUsers,
        newHost: roomData.metadata.host,
        timestamp: Date.now(),
      });
    }
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

function sendToUser(roomName, targetUsername, dataObj) {
  const roomData = rooms.get(roomName);
  if (!roomData || !targetUsername) return false;
  const targetClean = String(targetUsername).trim().toLowerCase();
  const serialized = JSON.stringify(dataObj);
  let delivered = false;

  for (const client of roomData.clients) {
    if (client.username && client.username.toLowerCase() === targetClean && client.ws.readyState === 1) {
      try {
        client.ws.send(serialized);
        delivered = true;
      } catch (_) {}
    }
  }
  return delivered;
}

function broadcast(roomName, dataObj, excludeWs = null) {
  const roomData = rooms.get(roomName);
  if (!roomData) return;
  const serialized = JSON.stringify(dataObj);
  for (const client of roomData.clients) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      try {
        client.ws.send(serialized);
      } catch (_) {}
    }
  }
}

function sanitizeUsername(name) {
  if (!name) return "Guest";
  const cleaned = name.replace(/[^\w\s\-\.]/g, "").trim().slice(0, 24);
  return cleaned || "Player";
}

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 api.cfat.site Engine & Local WebSocket Server Active`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Config: http://localhost:${PORT}/api/config`);
  console.log(`   Poker:  http://localhost:${PORT}/api/poker`);
  console.log(`======================================================\n`);
});
