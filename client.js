const WebSocket = require('ws');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Production server (Render)
const SERVER_URL = "wss://cli-chat-ic6w.onrender.com";

// Local development server
// const SERVER_URL = "ws://localhost:8080";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let ws;
let username;
let pendingFileMeta = null;

rl.question("Enter your username: ", (name) => {

    username = name.trim();

    ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        console.log("Connected to server");

        ws.send(JSON.stringify({
            type: "join",
            username: username
        }));

        rl.setPrompt(`${username}: `);
        rl.prompt();

        rl.on('line', handleInput);
    });

    ws.on('message', handleMessage);
});


function handleInput(input) {

    if (input.startsWith("send ")) {
        const filename = input.substring(5).trim();

        if (!fs.existsSync(filename)) {
            printLine("File not found.");
            return;
        }

        const fileBuffer = fs.readFileSync(filename);
        const stats = fs.statSync(filename);

        ws.send(JSON.stringify({
            type: "file-meta",
            from: username,
            filename: path.basename(filename),
            size: stats.size
        }));

        pendingFileMeta = {
            buffer: fileBuffer,
            filename: path.basename(filename)
        };

        return;
    }

    ws.send(JSON.stringify({
        type: "message",
        from: username,
        content: input
    }));
}


function handleMessage(data, isBinary) {

    if (isBinary) {
        if (pendingFileMeta && pendingFileMeta.receiving) {
            fs.writeFileSync(pendingFileMeta.filename, data);
            printLine(`File saved as ${pendingFileMeta.filename}`);
            pendingFileMeta = null;
        }
        return;
    }

    const msg = JSON.parse(data.toString());

    if (msg.type === "message" && msg.from !== username) {
        printLine(`${msg.from}: ${msg.content}`);
    }

    if (msg.type === "system") {
        printLine(`[System]: ${msg.content}`);
    }

    if (msg.type === "file-meta") {

        rl.question(
            `\nReceive ${msg.filename} (${msg.size} bytes)? Y/N: `,
            (answer) => {

                if (answer.toLowerCase() === "y") {

                    pendingFileMeta = {
                        filename: msg.filename,
                        receiving: true
                    };

                    ws.send(JSON.stringify({
                        type: "file-accept"
                    }));

                } else {
                    ws.send(JSON.stringify({
                        type: "file-reject"
                    }));
                }

                rl.prompt();
            }
        );
    }

    if (msg.type === "file-accept") {
        if (pendingFileMeta && pendingFileMeta.buffer) {
            ws.send(pendingFileMeta.buffer);
            printLine("File sent.");
            pendingFileMeta = null;
        }
    }

    if (msg.type === "file-reject") {
        printLine("Peer rejected the file.");
        pendingFileMeta = null;
    }
}


// Cleanly print a line without breaking prompt
function printLine(text) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    console.log(text);
    rl.prompt(true);
}