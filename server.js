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

        const data = JSON.parse(message.toString());

        if (data.type === "join") {
            ws.username = data.username;

            broadcast({
                type: "system",
                content: `${ws.username} joined the chat`
            }, ws);

        } else if (data.type === "file-meta") {

            // Forward file request including sender
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
        clients = clients.filter(client => client !== ws);
    });
});

function broadcast(msg, sender) {
    clients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
        }
    });
}