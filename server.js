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
  broadcast({ type: "online", count: wss.clients.size });
}

function broadcastTyping(username, isTyping) {
  broadcast({ type: "typing", username, isTyping });
}

// WebSocket logic
wss.on("connection", (ws, req) => {
  const remoteIP = getRemoteIP(req);
  clients.set(ws, { username: null, ip: remoteIP });

  // send chat history on connect
  ws.send(JSON.stringify({ type: "history", data: chatHistory }));
  updateOnlineCount();

  ws.on("message", (msgRaw) => {
    try {
      const data = JSON.parse(msgRaw);
      const client = clients.get(ws) || {};

      // Register username
      if (data.type === "register") {
        const newName = data.username || "Anonymous";
        const oldName = client.username || null;

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

        // assign name
        clients.set(ws, { username: newName, ip: remoteIP });

        // only announce if first registration or name changed
        if (!oldName) {
          console.log(`👤 ${guessDevice(data.userAgent)}  ${newName} — ${remoteIP}`);
          broadcast({ type: "system", text: `${newName} joined the chat` });
        } else if (oldName !== newName) {
          console.log(`✏️ ${oldName} → ${newName} — ${remoteIP}`);
          broadcast({ type: "system", text: `${oldName} changed name to ${newName}` });
        }

        updateOnlineCount();
        return;
      }

      // Typing events
      if (data.type === "typing") {
        const user = clients.get(ws);
        if (user?.username) broadcastTyping(user.username, data.isTyping);
        return;
      }

      // Clear chat (admin only)
      if (data.type === "chat" && data.text === "/clear" && client.username === "usayd") {
        chatHistory = [];
        broadcast({ type: "clear" });
        console.log("🧹 Chat cleared by admin");
        return;
      }

      // Normal chat messages
      if (data.type === "chat") {
        const entry = {
          username: client.username || "Anonymous",
          text: data.text,
          time: new Date().toLocaleTimeString(),
        };
        chatHistory.push(entry);

        // limit message history (prevent memory overload)
        if (chatHistory.length > 500) chatHistory.shift();

        broadcast({ type: "chat", data: entry });
        console.log(`[${entry.time}] ${entry.username}: ${entry.text}`);
      }
    } catch (e) {
      console.warn("Parse error:", e.message);
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
  });
});

server.listen(port, () => console.log(`🌐 Server running on port ${port}`));
