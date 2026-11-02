// Vercel Serverless Function: GET /api/poker-config
// Returns real-time poker configuration and WebSocket coordinator URL for api.cfat.site poker clients.

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
    service: "api.cfat.site (Poker Coordinator)",
    version: "2.0.0",
    domain: "api.cfat.site",
    wsUrl: wsUrl,
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
