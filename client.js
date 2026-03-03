const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = "ws://localhost:8080";

const ws = new WebSocket(SERVER_URL);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

ws.on('open', () => {
    console.log("Connected to server");

    rl.on('line', (input) => {
        ws.send(input);
    });
});

ws.on('message', (data) => {
    console.log("\nPeer:", data.toString());
});