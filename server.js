const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({
    port: PORT,
    host: "0.0.0.0"
});

let clients = [];
const MAX_CLIENTS = 5;

console.log(`Server running on port ${PORT}`);

wss.on('connection', function connection(ws) {

    if (clients.length >= MAX_CLIENTS) {
        ws.send(JSON.stringify({
            type: "system",
            content: "Server full (max 5 users allowed)"
        }));
        ws.close();
        return;
    }

    ws.username = null;
    ws.joined = false;   // NEW: track successful join

    clients.push(ws);

    ws.on('message', function incoming(message, isBinary) {

        // Binary file transfer
        if (isBinary) {
            clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(message, { binary: true });
                }
            });
            return;
        }

        let data;

        // Safe JSON parsing (prevents server crash)
        try {
            data = JSON.parse(message.toString());
        } catch {
            return;
        }

        if (data.type === "join") {

            ws.username = data.username;
            ws.joined = true;

            ws.send(JSON.stringify({
                type: "system",
                content: `Connected to default room: 8888`
            }));

            broadcast({
                type: "system",
                content: `${ws.username} joined the chat`
            }, ws);

        } else if (data.type === "file-meta") {

            broadcast({
                type: "file-meta",
                from: data.from,
                filename: data.filename,
                size: data.size
            }, ws);

        } else {

            broadcast(data, ws);

        }
    });

    ws.on('close', () => {

        // Remove client first
        clients = clients.filter(client => client !== ws);

        // Only broadcast leave if user actually joined
        if (ws.joined) {
            broadcast({
                type: "system",
                content: `${ws.username} left the chat`
            }, ws);
        }
    });
});

function broadcast(msg, sender) {
    clients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
        }
    });
}