const WebSocket = require('ws');

const PORT = 8080;

const wss = new WebSocket.Server({ port: PORT });

let clients = [];

console.log(`Server running on ws://localhost:${PORT}`);

wss.on('connection', function connection(ws) {
    console.log("New client connected");

    if (clients.length >= 2) {
        ws.send("Server full (only 2 clients allowed)");
        ws.close();
        return;
    }

    clients.push(ws);

    ws.on('message', function incoming(message) {
        console.log("Received:", message.toString());

        // Forward message to other client
        clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message.toString());
            }
        });
    });

    ws.on('close', () => {
        console.log("Client disconnected");
        clients = clients.filter(client => client !== ws);
    });
});