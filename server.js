import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = process.env.PORT || 8080;

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

let chatHistory = [];
const clients = new Map(); // ws -> {username, ip}

// helper: get IP
function getRemoteIP(req) {
  const forwarded = req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress.replace(/^::ffff:/, "");
}

// simple device guess from UA
function guessDevice(ua) {
  if (!ua) return "🖥️";
  ua = ua.toLowerCase();
  if (ua.includes("mobile") || ua.includes("android") || ua.includes("iphone")) return "📱";
  if (ua.includes("ipad") || (ua.includes("macintosh") && ua.includes("mobile"))) return "📱";
  if (ua.includes("windows") || ua.includes("macintosh") || ua.includes("linux")) return "🖥️";
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) return "🤖";
  return "🖥️";
}

// broadcast helper
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// update online count
function updateOnlineCount() {
  broadcast({ type: "online", count: wss.clients.size });
}

wss.on("connection", (ws, req) => {
  const remoteIP = getRemoteIP(req);
  clients.set(ws, { username: null, ip: remoteIP });

  ws.send(JSON.stringify({ type: "history", data: chatHistory }));
  updateOnlineCount();

  ws.on("message", (msgRaw) => {
    try {
      const data = JSON.parse(msgRaw);
      const client = clients.get(ws) || {};

      // Registration / username update
      if (data.type === "register") {
        const newName = data.username || "Anonymous";
        clients.set(ws, { username: newName, ip: remoteIP });
        console.log(`👤 ${guessDevice(data.userAgent)}  ${newName} — ${remoteIP}`);

        broadcast({ type: "system", text: `${newName} joined the chat` });
        updateOnlineCount();
        return;
      }

      // Ignore chat messages if not registered yet
      if (data.type === "chat" && (!client.username || client.username === null)) return;

      // Handle chat message
      if (data.type === "chat") {
        // Check for username change command
        if (data.text.startsWith("/name ")) {
          const newName = data.text.replace("/name ", "").trim();
          if (newName) {
            const oldName = client.username;
            clients.set(ws, { username: newName, ip: remoteIP });
            broadcast({ type: "system", text: `${oldName} changed name to ${newName}` });
            console.log(`✏️ ${oldName} → ${newName} — ${remoteIP}`);
            return;
          }
        }

        const entry = {
          username: client.username || "Anonymous",
          text: data.text,
          time: new Date().toLocaleTimeString(),
        };
        chatHistory.push(entry);
        broadcast({ type: "chat", data: entry });
        console.log(`[${entry.time}] ${entry.username}: ${entry.text}`);
      }

    } catch (e) {
      console.warn("Received non-json message or parse error:", e?.message || e);
    }
  });

  ws.on("close", () => {
    const info = clients.get(ws) || {};
    if (info.username) {
      broadcast({ type: "system", text: `${info.username} left the chat` });
      console.log(`🔴 ${info.username} disconnected — ${info.ip}`);
    } else {
      console.log(`🔴 Unknown client disconnected — ${info.ip}`);
    }
    clients.delete(ws);
    updateOnlineCount();
  });
});

server.listen(port, () => console.log(`✅ Server running on port ${port}`));
