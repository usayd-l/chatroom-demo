import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 8080;

// serve static files
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

// helper functions
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

// websocket behavior
wss.on("connection", (ws, req) => {
  const remoteIP = getRemoteIP(req);
  clients.set(ws, { username: null, ip: remoteIP });

  ws.send(JSON.stringify({ type: "history", data: chatHistory }));
  updateOnlineCount();

  ws.on("message", (msgRaw) => {
    try {
      const data = JSON.parse(msgRaw);
      const client = clients.get(ws);

      if (!client) return; // safety

      // handle registration
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

        // assign username once (no re-map of socket)
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

      // typing
      if (data.type === "typing") {
        if (client.username) broadcastTyping(client.username, data.isTyping);
        return;
      }

      // admin clear
      if (data.type === "chat" && data.text === "/clear" && client.username === "usayd") {
        chatHistory = [];
        broadcast({ type: "clear" });
        console.log("🧹 Chat cleared by admin");
        return;
      }

      // normal chat
      if (data.type === "chat") {
        const entry = {
          username: client.username || "Anonymous",
          text: data.text,
          // send an ISO timestamp so the client can format it in the user's local timezone
          time: new Date().toISOString(),
        };
        chatHistory.push(entry);
        if (chatHistory.length > 500) chatHistory.shift();
        broadcast({ type: "chat", data: entry });
        console.log(`[${entry.time}] ${entry.username}: ${entry.text}`);
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
  });
});

server.listen(port, () => console.log(`🌐 Server running on port ${port}`));
