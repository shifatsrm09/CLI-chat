# ⚡ CFAT Edge Real-Time Engine (`api.cfat.site`)

> High-performance, zero-server, persistent room-based real-time coordination engine for **`api.cfat.site`**.  
> Powers real-time multiplayer games (Texas Hold'em Poker, etc.) and low-latency room chat at the edge with Cloudflare Durable Objects.

---

## ⚡ Architecture & Capabilities

- **Zero Cold Starts**: 0ms connection latency powered by Cloudflare Durable Objects.
- **Multi-Game Coordination**:
  - Texas Hold'em Poker (`POKER-XXXX`) with private hole card routing, side-pot tracking, and turn synchronization.
  - Room Chat (`CHAT-XXXX`) with presence, audio notifications, and active participant drawers.
- **Targeted Private Messaging**:
  - Secure 1-to-1 packet routing (`targetUser` / `to`) so secret player cards remain completely private until showdown.
- **Edge Flood & Rate Limiting**:
  - Built-in token-bucket rate limiting per connection (max 75 msgs/5s) and 64KB message cap to guarantee server stability.
- **Universal REST Endpoints**:
  - `GET /api/health` — Health check, engine stats, and version info.
  - `GET /api/config` — Edge WebSocket coordinator URL & game settings.
  - `GET /api/games` — Catalog of supported multiplayer games.
  - `GET /api/poker-config` — Poker buy-in, blinds structure, and turn timer configuration.
  - `POST /api/rooms/create?game=poker` — Instant room generator.
  - `GET /api/rooms/info?room=POKER-1001` — Non-intrusive room participant inspector.
  - `GET /ws?room=CODE&user=NAME&game=GAME` — WebSocket connection gateway.

---

## 🛠️ Project Structure

```
api-cfat-site/
├── public/                 # Static Web Portal & Room Client
│   ├── index.html          # Clean responsive lobby & developer console
│   ├── style.css           # Modern dark-mode aesthetic
│   └── app.js              # Client WebSocket manager & room logic
├── worker/
│   └── index.js            # Cloudflare Worker + Durable Objects game & room coordinator
├── api/
│   ├── config.js           # Vercel serverless platform config
│   └── poker-config.js     # Poker-specific coordinator configuration
├── dev-server.js           # Full local HTTP + WebSocket parity server
├── wrangler.jsonc          # Cloudflare Worker configuration ("name": "api")
└── vercel.json             # Vercel deployment configuration
```

---

## 🚀 1. Local Testing

```bash
npm install
npm run dev
```

Open your browser to:
```
http://localhost:3000
```

Try the REST endpoints:
- `http://localhost:3000/api/health`
- `http://localhost:3000/api/config`
- `http://localhost:3000/api/poker-config`

---

## ☁️ 2. Deploying to Cloudflare Worker (`api.cfat-api.workers.dev`)

1. **Deploy the Worker**:
   ```bash
   npx wrangler deploy
   ```
2. Your live worker subdomain will be:
   ```
   https://api.cfat-api.workers.dev
   wss://api.cfat-api.workers.dev/ws
   ```
3. In Cloudflare Dashboard, bind your custom domain **`api.cfat.site`** under:
   **Worker Settings -> Domains & Routes -> Custom Domains**.

---

## ▲ 3. Deploying to Vercel

1. Import the GitHub repository **`shifatsrm09/api-cfat-site`** in Vercel.
2. In Vercel Project Settings -> **Domains**, bind **`api.cfat.site`**.
3. Environment Variables (optional override):
   - `NEXT_PUBLIC_WS_URL`: `wss://api.cfat-api.workers.dev/ws`
