require('dotenv').config();

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({
    port: PORT,
    host: "0.0.0.0"
});

let clients = [];
const MAX_CLIENTS = 5;

console.log(`Server running on port ${PORT}`);
console.log("API KEY:", process.env.OPENROUTER_API_KEY ? "Loaded" : "Missing");

async function askAI(prompt) {

    try {

        console.log("AI PROMPT:", prompt);

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost",
                "X-Title": "cli-chat"
            },
            body: JSON.stringify({
               model: "openrouter/free",
                max_tokens: 400,
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ]
            })
        });

        const data = await response.json();

        console.log("AI RAW RESPONSE:", JSON.stringify(data, null, 2));

        if (!response.ok) {
            console.log("OPENROUTER ERROR:", data);
            return "AI error: " + (data.error?.message || "unknown error");
        }

        if (data.choices && data.choices.length > 0) {

            const content = data.choices[0].message?.content;

            if (content) {
                return content;
            }

            return "AI returned an empty message.";
        }

        return "AI returned no choices.";

    } catch (err) {

        console.log("AI ERROR:", err);
        return "AI request failed.";

    }

}

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

    ws.on('message', async function incoming(message, isBinary) {

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

        // User joining
        if (data.type === "join") {

            ws.username = data.username;

            ws.send(JSON.stringify({
                type: "system",
                content: `Connected to default room: 8888`
            }));

            broadcast({
                type: "system",
                content: `${ws.username} joined the chat`
            }, ws);

        }

        // AI command
        else if (data.type === "message" && data.content.startsWith("/ai ")) {

            const prompt = data.content.replace("/ai ", "");

            broadcast({
                type: "system",
                content: `${ws.username} asked AI...`
            }, ws);

            const aiResponse = await askAI(prompt);

            console.log("AI FINAL RESPONSE:", aiResponse);

            broadcast({
                type: "message",
                from: "AI",
                content: aiResponse
            });

        }

        // File transfer
        else if (data.type === "file-meta") {

            broadcast({
                type: "file-meta",
                from: data.from,
                filename: data.filename,
                size: data.size
            }, ws);

        }

        // Normal chat message
        else {
            broadcast(data, ws);
        }

    });

    ws.on('close', () => {

        if (ws.username) {
            broadcast({
                type: "system",
                content: `${ws.username} left the chat`
            }, ws);
        }

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