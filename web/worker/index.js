/**
 * CFAT Real-Time Engine (api.cfat.site)
 * Scalable Edge WebSocket Coordinator & Room Relay powered by Cloudflare Durable Objects.
 * Designed for zero-server, 0ms cold-start multiplayer gaming (Poker, etc.) & live chat.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Universal CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 2. Real-time WebSocket Gateway: /ws?room=CODE&user=NAME&game=GAME&role=ROLE
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response(
          JSON.stringify({ error: "Expected WebSocket Upgrade connection", code: 426 }),
          { status: 426, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }

      const rawRoom = url.searchParams.get("room") || "LOBBY-1";
      const roomName = rawRoom.toUpperCase().trim().slice(0, 32);

      // Route to room's isolated Durable Object instance
      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);

      return roomObject.fetch(request);
    }

    // 3. Health check API
    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return jsonResponse({
        status: "healthy",
        service: "api.cfat.site",
        engine: "Cloudflare Durable Objects",
        version: "2.0.0",
        features: [
          "edge-websockets",
          "durable-objects",
          "targeted-messaging",
          "rate-limiting",
          "multi-game-coordination",
          "poker-engine-v2",
          "presence-sync"
        ],
        timestamp: new Date().toISOString(),
      });
    }

    // 4. Central Platform Config API
    if (url.pathname === "/api/config") {
      const isHttps = url.protocol === "https:";
      const host = url.host;
      const wsProtocol = isHttps ? "wss:" : "ws:";

      return jsonResponse({
        status: "ok",
        service: "api.cfat.site (CFAT Edge API)",
        version: "2.0.0",
        domain: "api.cfat.site",
        wsUrl: `${wsProtocol}//${host}/ws`,
        supportedGames: ["poker", "chat"],
        maxRoomPlayers: 16,
        timestamp: new Date().toISOString(),
      });
    }

    // 5. Supported Games Catalog API
    if (url.pathname === "/api/games") {
      return jsonResponse({
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
            features: ["private-hole-cards", "side-pots", "ai-bots", "reactions"],
          },
          {
            id: "chat",
            name: "Real-Time Room Chat",
            maxPlayers: 100,
            roomPrefix: "CHAT-",
            features: ["text-messages", "presence", "audio-chimes"],
          },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    // 6. Poker Specific Configuration API
    if (url.pathname === "/api/poker" || url.pathname === "/api/poker-config") {
      const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
      return jsonResponse({
        status: "ok",
        game: "poker",
        name: "CFAT Texas Hold'em",
        wsUrl: `${wsProtocol}//${url.host}/ws`,
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
      });
    }

    // 7. Create Room Code Generator API
    if (url.pathname === "/api/rooms/create" && (request.method === "POST" || request.method === "GET")) {
      const gameType = (url.searchParams.get("game") || "CHAT").toLowerCase();
      const randomNum = Math.floor(1000 + Math.random() * 9000);
      const roomCode = String(randomNum);
      const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";

      return jsonResponse({
        status: "ok",
        room: roomCode,
        game: gameType,
        wsUrl: `${wsProtocol}//${url.host}/ws?room=${roomCode}`,
        createdAt: new Date().toISOString(),
      });
    }

    // 8. Room Info Query API (Inspects participants without joining)
    if (url.pathname === "/api/rooms/info") {
      const roomName = (url.searchParams.get("room") || "").toUpperCase().trim();
      if (!roomName) {
        return jsonResponse({ error: "Missing 'room' query parameter" }, 400);
      }
      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);

      // Forward request to Durable Object internal query
      const internalReq = new Request(new URL("/internal/info", request.url));
      return roomObject.fetch(internalReq);
    }

    // Default Landing Response: API Overview
    return jsonResponse({
      service: "api.cfat.site",
      description: "CFAT High-Performance Edge Real-Time Engine & Multiplayer Gaming Hub",
      version: "2.0.0",
      status: "online",
      endpoints: {
        websocket: "wss://api.cfat.site/ws?room=ROOM_CODE&user=USERNAME&game=GAME",
        health: "https://api.cfat.site/api/health",
        config: "https://api.cfat.site/api/config",
        games: "https://api.cfat.site/api/games",
        pokerConfig: "https://api.cfat.site/api/poker-config",
        createRoom: "POST https://api.cfat.site/api/rooms/create?game=poker",
        roomInfo: "GET https://api.cfat.site/api/rooms/info?room=POKER-1001",
      },
      documentation: "https://github.com/shifatsrm09/api-cfat-site",
      timestamp: new Date().toISOString(),
    });
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/**
 * ChatRoom Durable Object
 * Authoritative edge coordinator managing WebSocket sessions, targeted card routing,
 * flood control, and presence synchronization for a single room.
 */
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;

    // Active sessions: Map<WebSocket, { id: string, username: string, game: string, role: string, joinedAt: number, msgCount: number, windowStart: number }>
    this.sessions = new Map();
    this.roomMetadata = {
      createdAt: Date.now(),
      game: "general",
      host: null,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal Room Info Query from Worker fetch
    if (url.pathname === "/internal/info") {
      const activeUsers = Array.from(this.sessions.values()).map((s) => ({
        username: s.username,
        role: s.role,
        joinedAt: s.joinedAt,
      }));

      return jsonResponse({
        status: "ok",
        room: url.searchParams.get("room"),
        userCount: this.sessions.size,
        users: activeUsers,
        game: this.roomMetadata.game,
        createdAt: this.roomMetadata.createdAt,
      });
    }

    // WebSocket Upgrade Request
    const rawUser = (url.searchParams.get("user") || "Guest").trim();
    const username = sanitizeUsername(rawUser);
    const room = (url.searchParams.get("room") || "LOBBY").toUpperCase().trim().slice(0, 32);
    const game = (url.searchParams.get("game") || (room.startsWith("POKER-") ? "poker" : "chat")).toLowerCase();
    const role = (url.searchParams.get("role") || "player").toLowerCase();
    const clientId = (url.searchParams.get("clientId") || url.searchParams.get("client_id") || "").trim();

    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);

    await this.handleSession(serverWs, { username, room, game, role, clientId });

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
      headers: CORS_HEADERS,
    });
  }

  async handleSession(ws, { username, room, game, role, clientId }) {
    ws.accept();

    const sessionId = crypto.randomUUID();
    const now = Date.now();

    // Check if handle is already taken by another active participant in this room
    const cleanLowerUser = username.toLowerCase();
    for (const [existingWs, existingInfo] of this.sessions.entries()) {
      if (existingInfo.username.toLowerCase() === cleanLowerUser) {
        // If it is the exact same client instance reconnecting with its unique clientId, allow seamless session resumption
        if (clientId && existingInfo.clientId && existingInfo.clientId === clientId) {
          try {
            existingWs.close(1000, "Reconnected elsewhere");
          } catch (_) {}
          this.sessions.delete(existingWs);
          break;
        }

        // If the existing user is actively connected, REJECT the newcomer!
        if (existingWs.readyState === 1 /* OPEN */) {
          this.sendJson(ws, {
            type: "error",
            code: "USERNAME_TAKEN",
            error: `Handle "${username}" is already in use in room ${room}. Please choose a different handle.`,
          });
          try {
            ws.close(4003, "Username already taken");
          } catch (_) {}
          return;
        } else {
          // Stale / closed session, prune it
          this.sessions.delete(existingWs);
        }
      }
    }

    // Register new session
    const sessionInfo = {
      id: sessionId,
      clientId,
      username,
      room,
      game,
      role,
      joinedAt: now,
      lastSeen: now,
      msgCount: 0,
      windowStart: now,
    };
    this.sessions.set(ws, sessionInfo);

    // First player becomes initial room host candidate
    if (!this.roomMetadata.host || this.sessions.size === 1) {
      this.roomMetadata.host = username;
      this.roomMetadata.game = game;
    }

    const currentUsers = Array.from(this.sessions.values()).map((s) => s.username);

    // 1. Send Room State to joined client
    this.sendJson(ws, {
      type: "room_state",
      room,
      user: username,
      users: currentUsers,
      game,
      role,
      host: this.roomMetadata.host,
      timestamp: now,
    });

    // 2. Broadcast user_joined to other participants
    this.broadcast(
      {
        type: "user_joined",
        user: username,
        users: currentUsers,
        game,
        timestamp: now,
      },
      ws
    );

    // 3. Handle incoming client messages
    ws.addEventListener("message", async (msgEvent) => {
      try {
        const rawData = msgEvent.data;
        if (typeof rawData !== "string" || rawData.length > 131072) {
          // Payload too large (max 128KB)
          return this.sendJson(ws, { type: "error", error: "Message exceeds 128KB limit" });
        }

        // Rate limiting: max 800 messages per 5 seconds (allows rapid file streaming & re-transmissions)
        const currentTime = Date.now();
        sessionInfo.lastSeen = currentTime;
        if (currentTime - sessionInfo.windowStart > 5000) {
          sessionInfo.windowStart = currentTime;
          sessionInfo.msgCount = 0;
        }
        sessionInfo.msgCount++;
        if (sessionInfo.msgCount > 800) {
          return this.sendJson(ws, {
            type: "error",
            error: "Rate limit exceeded. Please wait a moment.",
            code: "RATE_LIMITED",
          });
        }

        const payload = JSON.parse(rawData);

        // A. Ping / Keepalive
        if (payload.type === "ping") {
          return this.sendJson(ws, { type: "pong", timestamp: Date.now() });
        }

        // B. Standard Chat Message
        if (payload.type === "chat" && typeof payload.text === "string") {
          const text = payload.text.trim().slice(0, 1000);
          if (!text) return;

          const broadcastMsg = {
            type: "chat",
            id: crypto.randomUUID(),
            user: username,
            message: text,
            timestamp: Date.now(),
          };
          this.broadcast(broadcastMsg);
          return;
        }

        // C. Game / Poker Action & State Synchronization
        if (payload.type === "poker" || payload.type === "game" || payload.type === "action") {
          const gameMsg = {
            ...payload,
            fromUser: username,
            timestamp: Date.now(),
          };

          // Update host tracking if claim_host event
          if (payload.action === "claim_host" && payload.newHost) {
            this.roomMetadata.host = payload.newHost;
          }

          // Targeted message: Sent ONLY to a specific user (critical for private hole cards!)
          const target = payload.targetUser || payload.to;
          if (target) {
            this.sendToUser(target, gameMsg);
          } else {
            // Room broadcast
            this.broadcast(gameMsg, payload.excludeSelf ? ws : null);
          }
          return;
        }

        // D. Room State Refresh Query
        if (payload.type === "get_room_state") {
          return this.sendJson(ws, {
            type: "room_state",
            room,
            user: username,
            users: Array.from(this.sessions.values()).map((s) => s.username),
            game: this.roomMetadata.game,
            host: this.roomMetadata.host,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error("Worker packet processing error:", err);
        this.sendJson(ws, { type: "error", error: "Malformed JSON packet" });
      }
    });

    // Cleanup on disconnect
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;

      // Only broadcast user_left if this session was actually registered
      if (!this.sessions.has(ws)) return;
      this.sessions.delete(ws);

      const remainingUsers = Array.from(this.sessions.values()).map((s) => s.username);

      // Re-assign host if the host disconnected
      if (this.roomMetadata.host === username) {
        this.roomMetadata.host = remainingUsers[0] || null;
      }

      this.broadcast({
        type: "user_left",
        user: username,
        users: remainingUsers,
        newHost: this.roomMetadata.host,
        timestamp: Date.now(),
      });
    };

    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  sendJson(ws, obj) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (_) {}
    }
  }

  sendToUser(targetUsername, messageObj) {
    if (!targetUsername) return false;
    const targetClean = String(targetUsername).trim().toLowerCase();
    const serialized = JSON.stringify(messageObj);
    let delivered = false;

    for (const [ws, info] of this.sessions.entries()) {
      if (info && info.username && info.username.toLowerCase() === targetClean) {
        try {
          if (ws.readyState === 1) {
            ws.send(serialized);
            delivered = true;
          }
        } catch (_) {
          this.sessions.delete(ws);
        }
      }
    }
    return delivered;
  }

  broadcast(messageObj, excludeWs = null) {
    const serialized = JSON.stringify(messageObj);
    for (const [ws] of this.sessions.entries()) {
      if (ws !== excludeWs) {
        try {
          if (ws.readyState === 1) {
            ws.send(serialized);
          }
        } catch (_) {
          this.sessions.delete(ws);
        }
      }
    }
  }
}

function sanitizeUsername(name) {
  if (!name) return "Guest";
  const cleaned = name.replace(/[^\w\s\-\.]/g, "").trim().slice(0, 24);
  return cleaned || "Player";
}
