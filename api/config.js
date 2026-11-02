// Vercel Serverless Function: GET /api/config
// Central configuration provider for api.cfat.site clients.

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || process.env.WS_URL || "wss://api.cfat-api.workers.dev/ws";

  res.status(200).json({
    status: "ok",
    service: "api.cfat.site",
    version: "2.0.0",
    domain: "api.cfat.site",
    wsUrl: wsUrl,
    supportedGames: ["poker", "chat"],
    poker: {
      enabled: true,
      wsUrl: wsUrl,
      maxPlayers: 8,
      defaultBuyIn: 1000,
      defaultBlinds: [10, 20],
      turnTimerSeconds: 25,
    },
    timestamp: new Date().toISOString(),
  });
}
