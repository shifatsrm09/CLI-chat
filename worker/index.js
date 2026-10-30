/**
 * Cloudflare Worker with Durable Objects for Room-based Real-time Chat
 * Zero-server, 0ms cold start, free tier enabled.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Enable CORS for web clients connecting from chat.cfat.site
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // 1. WebSocket endpoint: /ws?room=CODE&user=NAME
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket connection", { status: 426 });
      }

      const roomName = (url.searchParams.get("room") || "DEFAULT").toUpperCase().trim();
      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);

      return roomObject.fetch(request);
    }

    // 2. Health check endpoint
    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          engine: "Cloudflare Durable Objects",
          version: "1.0.0",
          time: new Date().toISOString(),
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return new Response(
      "chat.cfat.site WebSocket Engine Active. Connect via WebSocket to /ws?room=ROOM_CODE&user=USERNAME",
      {
        status: 200,
        headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
      }
    );
  },
};

/**
 * ChatRoom Durable Object: Coordinates real-time messages and state for a single room.
 */
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    // Map of active WebSocket -> { username: string, joinedAt: number }
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const username = (url.searchParams.get("user") || "Guest").trim().slice(0, 32);
    const room = (url.searchParams.get("room") || "DEFAULT").toUpperCase().trim();

    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);

    await this.handleSession(serverWs, username, room);

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  async handleSession(ws, username, room) {
    ws.accept();
    this.sessions.set(ws, { username, joinedAt: Date.now() });

    // Retrieve active participants in room
    const currentUsers = Array.from(this.sessions.values()).map((s) => s.username);

    // Send room welcome & state directly to newly joined user
    ws.send(
      JSON.stringify({
        type: "room_state",
        room,
        user: username,
        users: currentUsers,
        timestamp: Date.now(),
      })
    );

    // Notify other users in the room
    this.broadcast(
      {
        type: "user_joined",
        user: username,
        users: currentUsers,
        timestamp: Date.now(),
      },
      ws
    );

    // Handle incoming messages
    ws.addEventListener("message", async (msgEvent) => {
      try {
        const payload = JSON.parse(msgEvent.data);
        if (payload.type === "chat" && typeof payload.text === "string") {
          const text = payload.text.trim().slice(0, 2000);
          if (!text) return;

          const broadcastMsg = {
            type: "chat",
            id: crypto.randomUUID(),
            user: username,
            message: text,
            timestamp: Date.now(),
          };

          this.broadcast(broadcastMsg);
        } else if (payload.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        }
      } catch (err) {
        console.error("Worker msg error:", err);
      }
    });

    const cleanup = () => {
      this.sessions.delete(ws);
      const remainingUsers = Array.from(this.sessions.values()).map((s) => s.username);
      this.broadcast({
        type: "user_left",
        user: username,
        users: remainingUsers,
        timestamp: Date.now(),
      });
    };

    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  broadcast(messageObj, excludeWs = null) {
    const serialized = JSON.stringify(messageObj);
    for (const [ws] of this.sessions.entries()) {
      if (ws !== excludeWs) {
        try {
          ws.send(serialized);
        } catch (_) {
          this.sessions.delete(ws);
        }
      }
    }
  }
}
