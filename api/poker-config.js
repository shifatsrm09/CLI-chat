// Vercel Serverless Function: GET /api/poker-config
// Returns real-time poker configuration and WebSocket coordinator URL for poker.cfat.site or any poker client.

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || process.env.WS_URL || "wss://chat-api.cfat-api.workers.dev/ws";

  res.status(200).json({
    status: "ok",
    service: "CFAT Live Poker Coordinator",
    wsUrl: wsUrl,
    maxPlayers: 8,
    defaultBuyIn: 1000,
    defaultBlinds: [10, 20],
    turnTimeSeconds: 25,
    timestamp: new Date().toISOString(),
  });
}
