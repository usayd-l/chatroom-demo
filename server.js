import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 8080;

// Serve static files
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
    } else {
      const type = req.url.endsWith(".js") ? "application/javascript" : "text/html";
      res.writeHead(200, { "Content-Type": type });
      res.end(data);
    }
  });
});

const wss = new WebSocketServer({ server });
const clients = new Map();
let chatHistory = [];

// --- Helpers ---
function getRemoteIP(req) {
  const forwarded = req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress.replace(/^::ffff:/, "");
}

function guessDevice(ua) {
  if (!ua) return "🖥️";
  ua = ua.toLowerCase();
  if (ua.includes("mobile") || ua.includes("android") || ua.includes("iphone")) return "📱";
  if (ua.includes("ipad") || (ua.includes("macintosh") && ua.includes("mobile"))) return "📱";
  if (ua.includes("windows") || ua.includes("macintosh") || ua.includes("linux")) return "🖥️";
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) return "🤖";
  return "🖥️";
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function updateOnline() {
  const users = Array.from(clients.values())
    .filter(c => c.username)
    .map(c => c.username);
  broadcast({ type: "online", count: users.length, users });
}

// --- WebSocket Behavior ---
wss.on("connection", (ws, req) => {
  const remoteIP = getRemoteIP(req);
  clients.set(ws, { username: null, ip: remoteIP });

  ws.send(JSON.stringify({ type: "history", data: chatHistory }));
  updateOnline();

  ws.on("message", async (msgRaw) => {
    try {
      const data = JSON.parse(msgRaw);
      const client = clients.get(ws);
      if (!client) return;

      // --- Registration ---
      if (data.type === "register") {
        const newName = data.username || "Anonymous";
        const oldName = client.username;

        const taken = Array.from(clients.values()).some(
          c => c.username === newName && c !== client
        );
        if (taken) {
          ws.send(JSON.stringify({
            type: "system",
            text: `⚠️ Username '${newName}' is already taken.`
          }));
          return;
        }

        client.username = newName;
        clients.set(ws, client);

        if (!oldName) broadcast({ type: "system", text: `${newName} joined the chat` });
        else if (oldName !== newName) broadcast({ type: "system", text: `${oldName} → ${newName}` });

        updateOnline();
        return;
      }

      // --- Typing ---
      if (data.type === "typing") {
        if (client.username) broadcast({ type: "typing", username: client.username, isTyping: data.isTyping });
        return;
      }

      // --- Admin clear ---
      if (data.type === "chat" && data.text === "/clear" && client.username === "usayd") {
        chatHistory = [];
        broadcast({ type: "clear" });
        console.log("🧹 Chat cleared by admin");
        return;
      }

      // --- Giphy command ---
      if (data.type === "chat" && data.text.startsWith("/gif ")) {
        const keyword = data.text.slice(5).trim();
        if (keyword) {
          const res = await fetch(`https://api.giphy.com/v1/gifs/random?api_key=dc6zaTOxFJmzC&tag=${encodeURIComponent(keyword)}&rating=g`);
          const json = await res.json();
          const gifUrl = json.data?.images?.downsized_medium?.url;
          if (gifUrl) {
            broadcast({ type: "chat", data: { username: client.username, text: gifUrl, isGif: true, time: new Date().toISOString() } });
          } else {
            ws.send(JSON.stringify({ type: "system", text: `No GIF found for '${keyword}'` }));
          }
        }
        return;
      }

      // --- Normal chat ---
      if (data.type === "chat") {
        const entry = {
          username: client.username || "Anonymous",
          text: data.text,
          time: new Date().toISOString()
        };
        chatHistory.push(entry);
        if (chatHistory.length > 500) chatHistory.shift();
        broadcast({ type: "chat", data: entry });
        console.log(`[${new Date().toLocaleString()}] ${entry.username}: ${entry.text}`);
      }

    } catch (err) {
      console.warn("Parse error:", err.message);
    }
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    if (client?.username) broadcast({ type: "system", text: `${client.username} left the chat` });
    clients.delete(ws);
    updateOnline();

    if (wss.clients.size === 0) {
      chatHistory = [];
      console.log("💾 All users disconnected — chat cleared.");
    }
  });
});

server.listen(port, () => console.log(`🌐 Server running on port ${port}`));
