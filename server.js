require('dotenv').config();

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({
    port: PORT,
    host: "0.0.0.0"
});

let clients = [];
const MAX_CLIENTS = 5;

let lastAIRequest = 0;
const AI_COOLDOWN = 3000;

console.log(`Server running on port ${PORT}`);
const USE_OLLAMA = true;  // Set to false to use OpenRouter instead

console.log("Using Ollama:", USE_OLLAMA ? "Yes" : "No");
console.log("API Key:", USE_OLLAMA ? (process.env.OLLAMA_API_KEY ? "Loaded" : "Not needed (local Ollama)") : (process.env.OPENROUTER_API_KEY ? "Loaded" : "Missing"));


function extractAIContent(data) {

    if (!data || !data.choices || data.choices.length === 0) {
        return null;
    }

    const choice = data.choices[0];

    // Standard OpenAI format
    if (choice.message && choice.message.content) {

        if (typeof choice.message.content === "string") {
            return choice.message.content;
        }

        if (Array.isArray(choice.message.content)) {
            return choice.message.content
                .map(part => part.text || part.content || "")
                .join("");
        }

    }

    // Some models return text directly
    if (choice.text) {
        return choice.text;
    }

    // Reasoning models (like DeepSeek)
    if (choice.reasoning && choice.reasoning.text) {
        return choice.reasoning.text;
    }

    // Some models return output_text
    if (choice.output_text) {
        return choice.output_text;
    }

    return null;
}


async function askAI(prompt) {

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {

        console.log("AI PROMPT:", prompt);

        let model = "qwen3-coder-next:cloud";
        let apiKey = "";
        let apiEndpoint = "https://ollama.com/v1/chat/completions";

        if (!USE_OLLAMA) {
            // OpenRouter configuration
            model = "openrouter/free";
            apiKey = process.env.OPENROUTER_API_KEY || "";
            apiEndpoint = "https://openrouter.ai/api/v1/chat/completions";
        } else {
            // Ollama Cloud configuration
            apiKey = process.env.OLLAMA_API_KEY || "";
            // Use Ollama Cloud API (compatible with OpenAI format)
            apiEndpoint = "https://ollama.com/v1/chat/completions";
        }

        const headers = {
            "Content-Type": "application/json",
        };

        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const response = await fetch(apiEndpoint, {

            method: "POST",

            headers: headers,

            signal: controller.signal,

            body: JSON.stringify({
                model: model,
                max_tokens: 1500,
                messages: [
                    {
                        role: "system",
                        content: "Answer clearly and concisely. Do not include internal reasoning."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ]
            })

        });

        clearTimeout(timeout);

        if (!response.ok) {

            const text = await response.text();
            console.log("AI API ERROR:", text);
            return "AI service error.";

        }

        const data = await response.json();

        console.log("AI RAW RESPONSE:", JSON.stringify(data, null, 2));

        let content = extractAIContent(data);

        if (!content) {

            console.log("UNKNOWN AI FORMAT:", JSON.stringify(data, null, 2));
            return "AI returned an empty response.";

        }

        content = content.trim();

        if (content.length === 0) {
            return "AI returned an empty response.";
        }

        if (content.length > 2000) {
            content = content.substring(0, 2000) + "\n\n[response truncated]";
        }

        return content;

    } catch (err) {

        console.log("AI ERROR:", err);

        if (err.name === "AbortError") {
            return "AI request timed out.";
        }

        return "AI request failed.";

    }

}



function canUseAI() {

    const now = Date.now();

    if (now - lastAIRequest < AI_COOLDOWN) {
        return false;
    }

    lastAIRequest = now;
    return true;

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

    ws.on('message', function incoming(message, isBinary) {

        if (isBinary) {

            clients.forEach(client => {

                if (client !== ws && client.readyState === WebSocket.OPEN) {

                    client.send(message, { binary: true });

                }

            });

            return;

        }

        let data;

        try {

            data = JSON.parse(message.toString());

        } catch {

            console.log("Invalid JSON received");
            return;

        }



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



        else if (data.type === "message" && data.content.startsWith("/ai ")) {

            if (!canUseAI()) {

                ws.send(JSON.stringify({
                    type: "system",
                    content: "AI cooldown active. Please wait a few seconds."
                }));

                return;

            }

            const prompt = data.content.replace("/ai ", "");

            broadcast({
                type: "system",
                content: `${ws.username} asked AI...`
            }, ws);


            askAI(prompt)
                .then((aiResponse) => {

                    broadcast({
                        type: "message",
                        from: "Ollama",
                        content: aiResponse
                    });

                })
                .catch(() => {

                    broadcast({
                        type: "system",
                        content: "AI failed to respond."
                    });

                });

        }



        else if (data.type === "file-meta") {

            broadcast({
                type: "file-meta",
                from: data.from,
                filename: data.filename,
                size: data.size
            }, ws);

        }



        else if (data.type === "file-accept") {

            broadcast({
                type: "file-accept"
            }, ws);

        }



        else if (data.type === "file-reject") {

            broadcast({
                type: "file-reject"
            }, ws);

        }



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