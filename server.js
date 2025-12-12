import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import fetch from "node-fetch"; // Make sure node-fetch is in package.json

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 8080;

const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

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
const clients = new Map(); // ws -> { username, ip }
let chatHistory = [];

// Helpers
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

function updateOnlineCount() {
  const connected = Array.from(wss.clients).filter(c => c.readyState === 1).length;
  broadcast({ type: "online", count: connected });
}

function broadcastTyping(username, isTyping) {
  broadcast({ type: "typing", username, isTyping });
}

// Fetch GIF from Giphy
async function fetchGif(query) {
  if (!GIPHY_API_KEY) return null;
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.data && data.data.length > 0) return data.data[0].images.fixed_height.url;
  } catch (err) {
    console.warn("GIF fetch error:", err.message);
  }
  return null;
}

// WebSocket behavior
wss.on("connection", (ws, req) => {
  const remoteIP = getRemoteIP(req);
  clients.set(ws, { username: null, ip: remoteIP });

  ws.send(JSON.stringify({ type: "history", data: chatHistory }));
  updateOnlineCount();

  ws.on("message", async (msgRaw) => {
    try {
      const data = JSON.parse(msgRaw);
      const client = clients.get(ws);
      if (!client) return;

      // Handle registration
      if (data.type === "register") {
        const newName = data.username || "Anonymous";
        const oldName = client.username;

        // prevent duplicate usernames
        const taken = Array.from(clients.values()).some(
          (c) => c.username === newName && c !== client
        );
        if (taken) {
          ws.send(JSON.stringify({
            type: "system",
            text: `⚠️ Username '${newName}' is already taken. Choose another one.`
          }));
          return;
        }

        client.username = newName;
        clients.set(ws, client);

        if (!oldName) {
          console.log(`👤 ${guessDevice(data.userAgent)} ${newName} — ${remoteIP}`);
          broadcast({ type: "system", text: `${newName} joined the chat` });
        } else if (oldName !== newName) {
          console.log(`✏️ ${oldName} → ${newName} — ${remoteIP}`);
          broadcast({ type: "system", text: `${oldName} changed name to ${newName}` });
        }

        updateOnlineCount();
        return;
      }

      // Typing indicator
      if (data.type === "typing") {
        if (client.username) broadcastTyping(client.username, data.isTyping);
        return;
      }

      // Admin clear command
      if (data.type === "chat" && data.text === "/clear" && client.username === "usayd") {
        chatHistory = [];
        broadcast({ type: "clear" });
        console.log("🧹 Chat cleared by admin");
        return;
      }

      // Active users command
      if (data.type === "chat" && data.text === "/users") {
        const users = Array.from(clients.values())
          .filter(c => c.username)
          .map(c => c.username);
        ws.send(JSON.stringify({ type: "system", text: `Active users: ${users.join(", ")}` }));
        return;
      }

      // Normal chat message, with GIF support
      if (data.type === "chat") {
        const entry = {
          username: client.username || "Anonymous",
          text: data.text,
          time: new Date().toISOString(),
        };

        // Check if message starts with /gif keyword
        if (entry.text.startsWith("/gif ")) {
          const query = entry.text.slice(5).trim();
          const gifUrl = await fetchGif(query);
          if (gifUrl) {
            entry.gif = gifUrl; // send to clients
          } else {
            ws.send(JSON.stringify({ type: "system", text: `No GIF found for '${query}'` }));
          }
        }

        chatHistory.push(entry);
        if (chatHistory.length > 500) chatHistory.shift();
        broadcast({ type: "chat", data: entry });

        // Server-side log
        const logTime = new Date(entry.time).toLocaleString();
        console.log(`[${logTime}] ${entry.username}: ${entry.text}`);
      }

    } catch (err) {
      console.warn("Parse error:", err.message);
    }
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    if (client?.username) {
      broadcast({ type: "system", text: `${client.username} left the chat` });
      console.log(`❌ ${client.username} disconnected`);
    }
    clients.delete(ws);
    updateOnlineCount();

    // Clear chat if no users left
    if (wss.clients.size === 0) {
      chatHistory = [];
      console.log("💾 All users disconnected — chat history cleared.");
    }
  });
});

server.listen(port, () => console.log(`🌐 Server running on port ${port}`));
