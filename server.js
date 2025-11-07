import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 8080;

// Admin usernames
const ADMINS = ["usayd"];

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
const MAX_HISTORY = 1000;
const clients = new Map(); // ws -> {username, ip}
const typingUsers = new Map(); // ws -> username

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

function updateTyping() {
  broadcast({ type: "typing_update", list: Array.from(typingUsers.values()) });
}

wss.on("connection", (ws, req) => {
  const remoteIP = getRemoteIP(req);
  clients.set(ws, { username: null, ip: remoteIP });

  // Send chat history
  ws.send(JSON.stringify({ type: "history", data: chatHistory }));
  updateOnlineCount();

  ws.on("message", (msgRaw) => {
    try {
      const data = JSON.parse(msgRaw);
      const client = clients.get(ws);

      // Registration / username
      if (data.type === "register") {
        const oldName = client.username || "Anonymous";
        const newName = data.username || "Anonymous";
        clients.set(ws, { username: newName, ip: remoteIP });

        // Update typing state if user was typing
        if (typingUsers.has(ws)) {
          typingUsers.set(ws, newName);
          updateTyping();
        }

        if (!client.username) {
          console.log(`👤 ${guessDevice(data.userAgent)}  ${newName} — ${remoteIP}`);
          broadcast({ type: "system", text: `${newName} joined the chat` });
        } else if (client.username !== newName) {
          console.log(`✏️ ${oldName} → ${newName} — ${remoteIP}`);
          broadcast({ type: "system", text: `${oldName} changed name to ${newName}` });
        }

        updateOnlineCount();
        return;
      }

      if (!client.username) return;

      // Admin /clear
      if (data.text === "/clear" && ADMINS.includes(client.username)) {
        chatHistory = [];
        broadcast({ type: "clear" });
        console.log(`🧹 Chat cleared by ${client.username} — ${remoteIP}`);
        return;
      }

      // Chat message
      if (data.type === "chat") {
        if (data.text.startsWith("/name ")) {
          const newName = data.text.replace("/name ", "").trim();
          if (newName && client.username !== newName) {
            const oldName = client.username || "Anonymous";
            clients.set(ws, { username: newName, ip: remoteIP });
            if (typingUsers.has(ws)) typingUsers.set(ws, newName);
            broadcast({ type: "system", text: `${oldName} changed name to ${newName}` });
            console.log(`✏️ ${oldName} → ${newName} — ${remoteIP}`);
          }
          return;
        }

        const entry = {
          username: client.username,
          text: data.text,
          time: new Date().toLocaleTimeString()
        };

        chatHistory.push(entry);
        if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
        broadcast({ type: "chat", data: entry });
        console.log(`[${entry.time}] ${entry.username}: ${entry.text}`);
      }

      // Typing events
      if (data.type === "typing") {
        typingUsers.set(ws, client.username);
        updateTyping();
      }

      if (data.type === "stop_typing") {
        typingUsers.delete(ws);
        updateTyping();
      }

    } catch (e) {
      console.warn("Received non-json message:", e?.message || e);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    typingUsers.delete(ws);
    updateOnlineCount();
    updateTyping();
  });
});

server.listen(port, () => {
  console.log(`Chat server running on port ${port}`);
});
