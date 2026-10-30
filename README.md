# CFAT Chat API (`chat.cfat.site`)

> Zero-server, zero-cost, persistent room-based real-time chat application for **`chat.cfat.site`**.  
> Powered by modern Edge WebSockets & Cloudflare Durable Objects.

---

## ⚡ Features
- **Zero Cold Starts**: 0ms connection latency (no 60s VM sleep/wake cycle like Render/Heroku).
- **100% Free Forever**: Runs within Cloudflare & Vercel generous free tiers ($0.00).
- **Room Coordination**:
  - Host a room (one-click code generator or custom code)
  - Join an existing room
  - Instant 1-click invite link sharing (`https://chat.cfat.site/?room=ROOM_CODE`)
- **Real-Time Experience**:
  - Real-time messages with timestamps and unique user avatar hues
  - Live participant count & active member drawer
  - Web Audio API notification sounds (synthesized dynamically in the browser, no external audio files required)
  - Automatic reconnection handling

---

## 🛠️ Project Structure

```
chat-api/
├── public/                 # Static Web Frontend (deployable to Vercel)
│   ├── index.html          # Clean, responsive single-page chat UI
│   ├── style.css           # Modern dark-mode aesthetic
│   └── app.js             # Client WebSocket manager & room logic
├── worker/
│   └── index.js           # Cloudflare Worker + Durable Objects room relay
├── api/
│   └── config.js          # Vercel serverless function (optional config)
├── dev-server.js           # Local HTTP + WebSocket server for testing
├── wrangler.jsonc          # Cloudflare Worker configuration
└── vercel.json             # Vercel deployment configuration
```

---

## 🚀 1. Local Testing

To run the complete chat app and WebSocket relay locally on your computer:

```bash
npm install
npm run dev
```

Open your browser to:
```
http://localhost:3000
```
Open two tabs, join the same room (e.g. `CFAT-1001`), and chat in real-time!

---

## ☁️ 2. Deploying to Cloudflare (Real-Time WebSocket Engine)

To deploy the Cloudflare Worker WebSocket coordinator with 0ms cold start:

1. **Log into Cloudflare**:
   ```bash
   npx wrangler login
   ```
2. **Deploy the Worker**:
   ```bash
   npx wrangler deploy
   ```
3. This creates your live WebSocket endpoint (e.g. `wss://chat-api.<your-subdomain>.workers.dev`).
4. (Optional) In Cloudflare Dashboard, bind your custom domain like `chat-api.cfat.site` or `ws.cfat.site` under **Worker Settings -> Domains**.

---

## ▲ 3. Deploying the Web Frontend to Vercel (`chat.cfat.site`)

1. Go to your [Vercel Dashboard](https://vercel.com).
2. Click **Add New Project** -> Import GitHub repository **`shifatsrm09/chat-api`**.
3. Framework Preset: **Other** (Output Directory: `public`).
4. (Optional) Set Environment Variable in Vercel:
   - `NEXT_PUBLIC_WS_URL`: `wss://your-cloudflare-worker-url.workers.dev/ws`
5. Click **Deploy**.
6. In Vercel Project Settings -> **Domains**, add **`chat.cfat.site`**.
