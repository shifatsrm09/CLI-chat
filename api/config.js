// Vercel Serverless Function: GET /api/config
// Allows configuring the Cloudflare WebSocket endpoint via Vercel Environment Variables without rebuilding the frontend.

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || process.env.WS_URL || "";

  res.status(200).json({
    status: "ok",
    service: "chat.cfat.site",
    wsUrl: wsUrl,
    timestamp: new Date().toISOString(),
  });
}
