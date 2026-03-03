const WebSocket = require('ws');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

let clients = [];

console.log(`Server running on ws://localhost:${PORT}`);

wss.on('connection', function connection(ws) {

    if (clients.length >= 2) {
        ws.send(JSON.stringify({
            type: "system",
            content: "Server full (only 2 clients allowed)"
        }));
        ws.close();
        return;
    }

    ws.username = null;
    clients.push(ws);

    ws.on('message', function incoming(message, isBinary) {

        // If binary → forward directly
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