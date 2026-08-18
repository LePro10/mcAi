/**
 * bot-daemon.mjs — Always-running Minecraft bot daemon (v3 — Performance)
 * 
 * - Persistent RCON connection (no reconnect per command)
 * - No bot teleportation spam (commands run server-side via RCON)
 * - Accurate biome detection (surface scan)
 * - Efficient chat rate limiting
 */

import mineflayer from "mineflayer";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Vec3 from "vec3";
import net from "node:net";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const QUEUE_FILE = path.resolve(PROJECT_DIR, "build_queue.json");
const BUILD_LOG_FILE = path.resolve(PROJECT_DIR, "build_log.txt");
const STRUCTURES_DIR = path.resolve(PROJECT_DIR, "structures");
const STYLES_DIR = path.resolve(PROJECT_DIR, "styles");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "/home/leandro/.opencode/bin/opencode";
const HTTP_PORT = parseInt(process.env.MC_HTTP_PORT || "8765");
const MC_HOST = process.env.MC_HOST || "localhost";
const MC_PORT = parseInt(process.env.MC_PORT || "25565");
const MC_USERNAME = process.env.MC_USERNAME || "AIBuilder";
const RCON_PORT = parseInt(process.env.RCON_PORT || "25575");
const RCON_PASSWORD = process.env.RCON_PASSWORD || "mcai2026";

let currentBuildProcess = null;
let currentBuildId = null;
let buildPhase = "";
let recentActivity = [];

function stripColor(s) {
  return s.replace(/\u00a7[0-9a-fklmnor]/gi, "");
}

function addActivity(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  recentActivity.push(entry);
  if (recentActivity.length > 50) recentActivity.shift();
  try { fs.appendFileSync(BUILD_LOG_FILE, entry + "\n"); } catch (_) {}
  console.log(entry);
  if (bot && connected && (
    msg.includes("Phase") ||
    msg.includes("Fill:") ||
    msg.includes("BUILD START") ||
    msg.includes("FINISHED") ||
    msg.includes("BUILD CANCELLED") ||
    msg.includes("Progress:") ||
    msg.includes("Details") ||
    msg.includes("Abschluss") ||
    msg.includes("Analyse")
  )) {
    const chatMsg = stripColor(msg.replace(/^\[.*?\] /, "")).substring(0, 55);
    safeChat("[AI] " + chatMsg);
  }
}

let chatQueue = [];
let chatTimer = null;
function safeChat(msg) {
  const clean = stripColor(msg);
  chatQueue.push(clean);
  if (!chatTimer) {
    chatTimer = setInterval(() => {
      if (chatQueue.length === 0) { clearInterval(chatTimer); chatTimer = null; return; }
      const m = chatQueue.shift();
      if (bot && connected) {
        try { bot.chat(m); } catch(_) {}
      }
    }, 500);
  }
}

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch { return []; }
}
function saveQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    addActivity(`QUEUE WRITE ERROR: ${err.message}`);
  }
}

// ── Bot Management ──
let bot = null;
let connected = false;
let position = { x: 0, y: 0, z: 0 };
let biome = "unknown";

function createBot() {
  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USERNAME,
    auth: "offline",
    hideErrors: false,
  });

  bot.once("spawn", () => {
    connected = true;
    position = {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z),
    };
    biome = findSurfaceBiome(position.x, position.z);

    console.log(`[Bot] Spawned at ${position.x},${position.y},${position.z} (${biome})`);
    safeChat("AI Builder online! !build <beschreibung>");
  });

  bot.on("move", () => {
    if (bot?.entity) {
      position = {
        x: Math.round(bot.entity.position.x),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z),
      };
    }
  });

  bot.on("chat", (username, message) => {
    const msg = message.trim();

    if (msg.startsWith("!build ") || msg.startsWith("!b ")) {
      const prompt = msg.startsWith("!build ") 
        ? msg.slice(7).trim() 
        : msg.slice(3).trim();
      
      if (!prompt) {
        safeChat(`@${username} Beispiel: !build eine riesige Burg im Wald`);
        return;
      }

      if (currentBuildProcess) {
        safeChat(`@${username} Build laeuft (#${currentBuildId?.slice(-6)}). !cancel zum Abbrechen.`);
        return;
      }

      const player = bot.players[username];
      if (!player || !player.entity) {
        safeChat(`@${username} Position nicht gefunden. Beweg dich kurz.`);
        return;
      }

      const playerPos = {
        x: Math.round(player.entity.position.x),
        y: Math.round(player.entity.position.y),
        z: Math.round(player.entity.position.z),
      };

      const request = {
        id: Date.now().toString(),
        player: username,
        prompt,
        position: playerPos,
        status: "building",
        timestamp: Date.now(),
      };
      currentBuildId = request.id;

      const queue = loadQueue();
      queue.push(request);
      saveQueue(queue);

      addActivity(`BUILD START #${request.id.slice(-6)}: ${username} — "${prompt}"`);
      addActivity(`  Position: ${playerPos.x},${playerPos.y},${playerPos.z}`);

      safeChat(`@${username} Bau #${request.id.slice(-6)}: "${prompt}" — AI baut...`);

      spawnOpenCode(request);
      return;
    }

    if (msg === "!thinking" || msg === "!think" || msg === "!t") {
      let info = "";
      if (currentBuildProcess) {
        info = `AI STATUS | Build #${currentBuildId?.slice(-6)} | Phase: ${buildPhase || "Analyse"}`;
        const lastGood = recentActivity.filter(a => a.includes("fill") || a.includes("Phase") || a.includes("BUILD") || a.includes("placed") || a.includes("filled")).slice(-2);
        if (lastGood.length > 0) info += ` | Last: ${lastGood[lastGood.length-1].slice(12).substring(0,60)}`;
        info += ` | !cancel`;
      } else if (currentBuildId) {
        info = `Build #${currentBuildId.slice(-6)} fertig. !build fuer neuen Auftrag`;
      } else {
        info = `Kein Build aktiv. !build <beschreibung>`;
      }
      safeChat(info);
      return;
    }

    if (msg === "!status" || msg === "!s") {
      const uptime = Math.floor(process.uptime());
      const pending = loadQueue().filter(r=>r.status==='pending'||r.status==='building').length;
      safeChat(`mcAI: Online ${Math.floor(uptime/60)}min | ${pending} Build(s) | !build | !thinking | !cancel`);
      return;
    }

    if (msg === "!cancel" || msg === "!stop") {
      if (currentBuildProcess) {
        currentBuildProcess.kill("SIGTERM");
        currentBuildProcess = null;
        addActivity(`BUILD CANCELLED #${currentBuildId?.slice(-6)} by ${username}`);
        safeChat(`@${username} Build #${currentBuildId?.slice(-6)} abgebrochen.`);
        if (currentBuildId) {
          const q = loadQueue();
          const idx = q.findIndex(r => r.id === currentBuildId);
          if (idx >= 0) { q[idx].status = "failed"; q[idx].result = "Cancelled by player"; saveQueue(q); }
          currentBuildId = null;
        }
        buildPhase = "";
      } else {
        safeChat(`@${username} Kein aktiver Build.`);
      }
      return;
    }
  });

  bot.on("end", (reason) => {
    console.error(`[Bot] Disconnected: ${reason}`);
    connected = false;
    scheduleReconnect();
  });

  bot.on("kicked", (reason) => {
    console.error(`[Bot] Kicked: ${JSON.stringify(reason)}`);
    connected = false;
    scheduleReconnect();
  });

  bot.on("error", (err) => {
    console.error(`[Bot] Error: ${err.message}`);
  });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  console.error("[Bot] Reconnecting in 5s...");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try { createBot(); } catch (e) {
      console.error("[Bot] Reconnect failed:", e);
      scheduleReconnect();
    }
  }, 5000);
}

function getVec3(x, y, z) {
  return new Vec3(x, y, z);
}

// ── Biome Detection (surface scan) ──
function findSurfaceBiome(x, z) {
  if (!bot) return "unknown";
  try {
    for (let y = 320; y >= -64; y--) {
      const block = bot.blockAt(getVec3(x, y, z));
      if (block && block.name !== "air" && block.name !== "void_air" && block.name !== "cave_air") {
        return block.biome?.name || "unknown";
      }
    }
  } catch (_) {}
  return "unknown";
}

// ── Persistent RCON ──

class PersistentRcon {
  constructor() {
    this.client = null;
    this.ready = false;
    this.commandQueue = [];
    this.currentCommand = null;
    this.respBuffer = Buffer.alloc(0);
    this.rconId = 0;
    this.reconnectTimer = null;
    this.connecting = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.connecting) {
        reject(new Error("Already connecting"));
        return;
      }
      this.connecting = true;
      this.ready = false;
      this.respBuffer = Buffer.alloc(0);

      this.client = new net.Socket();
      this.client.setTimeout(5000);

      const onError = (err) => {
        this.connecting = false;
        this.ready = false;
        reject(err);
      };

      this.client.once("error", onError);

      this.client.connect(RCON_PORT, MC_HOST, () => {
        const pw = Buffer.from(RCON_PASSWORD + "\x00\x00", "utf8");
        const remaining = 4 + 4 + pw.length;
        const len = Buffer.alloc(4); len.writeInt32LE(remaining, 0);
        const id = Buffer.alloc(4); id.writeInt32LE(0, 0);
        const type = Buffer.alloc(4); type.writeInt32LE(3, 0);
        this.client.write(Buffer.concat([len, id, type, pw]));
      });

      this.client.on("data", (data) => {
        this.respBuffer = Buffer.concat([this.respBuffer, data]);
        this._processBuffer();
      });

      this.client.once("login_success", () => {
        this.connecting = false;
        this.ready = true;
        this.client.setTimeout(0);
        this.client.removeListener("timeout", this._timeoutHandler);
        console.log("[RCON] Authenticated — persistent connection ready");
        addActivity("[RCON] Connected");
        this._drainQueue();
        resolve();
      });

      this.client.once("login_failed", () => {
        this.connecting = false;
        this.ready = false;
        console.error("[RCON] Authentication failed — check rcon.password in server.properties");
        addActivity("[RCON] Auth failed");
        reject(new Error("RCON authentication failed"));
      });

      this.client.on("close", () => {
        this.ready = false;
        this.connecting = false;
        if (this.currentCommand) {
          const cmd = this.currentCommand;
          this.currentCommand = null;
          cmd.resolve(cmd.partialResponse || "Connection lost");
          this._drainQueue();
        }
        this._scheduleReconnect();
      });

      this.client.on("error", (err) => {
        console.error(`[RCON] Connection error: ${err.message}`);
        this.ready = false;
      });

      this._timeoutHandler = () => {
        console.error("[RCON] Timeout — reconnecting");
        this.client.destroy();
      };
      this.client.on("timeout", this._timeoutHandler);
    });
  }

  _processBuffer() {
    while (this.respBuffer.length >= 12) {
      const pktLen = this.respBuffer.readInt32LE(0);
      if (this.respBuffer.length < 4 + pktLen) break;

      const pktId = this.respBuffer.readInt32LE(4);
      const pktType = this.respBuffer.readInt32LE(8);
      const payload = this.respBuffer.slice(12, 4 + pktLen).toString("utf8").replace(/\x00+$/, "").trim();
      this.respBuffer = this.respBuffer.slice(4 + pktLen);

      if (!this.ready) {
        if (pktType === 0 && !payload) continue;
        if (pktType === 2) {
          if (pktId === -1) {
            this.client.emit("login_failed");
          } else {
            this.client.emit("login_success");
          }
          return;
        }
        continue;
      }

      if (pktType === 0) {
        if (this.currentCommand) {
          if (payload) {
            this.currentCommand.partialResponse = 
              (this.currentCommand.partialResponse || "") + payload + "\n";
          }
          if (pktId === this.currentCommand.rconId) {
            const cmd = this.currentCommand;
            this.currentCommand = null;
            cmd.resolve((cmd.partialResponse || "").trim() || "OK");
            setTimeout(() => this._drainQueue(), 10);
          }
        }
      }
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (e) {
        console.error(`[RCON] Reconnect failed: ${e.message}`);
        addActivity(`[RCON] Reconnect failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }, 5000);
  }

  execute(command) {
    return new Promise((resolve, reject) => {
      const cmd = command.startsWith("/") ? command.slice(1) : command;
      const entry = { command: cmd, resolve, reject, partialResponse: "", rconId: 0 };

      const queueTimeout = setTimeout(() => {
        const idx = this.commandQueue.indexOf(entry);
        if (idx >= 0) {
          this.commandQueue.splice(idx, 1);
          resolve("OK (queued too long)");
        }
      }, 5000);

      entry._queueTimeout = queueTimeout;

      if (!this.ready) {
        this.commandQueue.push(entry);
        if (!this.connecting && !this.reconnectTimer) {
          this.connect().catch(() => {});
        }
        return;
      }

      this._sendCommand(entry);
    });
  }

  _sendCommand(entry) {
    if (entry._queueTimeout) { clearTimeout(entry._queueTimeout); entry._queueTimeout = null; }
    this.rconId++;
    entry.rconId = this.rconId;
    this.currentCommand = entry;

    const cmdBuf = Buffer.from(entry.command + "\x00\x00", "utf8");
    const rem = 4 + 4 + cmdBuf.length;
    const len = Buffer.alloc(4); len.writeInt32LE(rem, 0);
    const id = Buffer.alloc(4); id.writeInt32LE(this.rconId, 0);
    const type = Buffer.alloc(4); type.writeInt32LE(2, 0);

    try {
      this.client.write(Buffer.concat([len, id, type, cmdBuf]));
    } catch (err) {
      this.currentCommand = null;
      this.commandQueue.unshift(entry);
      this.ready = false;
      this._scheduleReconnect();
    }

    setTimeout(() => {
      if (this.currentCommand === entry) {
        const cmd = this.currentCommand;
        this.currentCommand = null;
        cmd.resolve(cmd.partialResponse || "OK (timeout)");
        this._drainQueue();
      }
    }, 10000);
  }

  _drainQueue() {
    if (this.currentCommand || !this.ready || this.commandQueue.length === 0) return;
    const next = this.commandQueue.shift();
    this._sendCommand(next);
  }

  destroy() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.client) { this.client.destroy(); this.client = null; }
    this.ready = false;
  }
}

const rcon = new PersistentRcon();

function executeCommand(command) {
  return new Promise(async (resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (bot && connected) {
          const cmd = command.startsWith("/") ? command : `/${command}`;
          bot.chat(cmd);
          addActivity(`[CHAT-FALLBACK] ${cmd}`);
          resolve(`OK (via bot chat)`);
        } else {
          resolve("FAILED (RCON timeout + bot offline)");
        }
      }
    }, 2000);

    try {
      const result = await rcon.execute(command);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(result);
      }
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (bot && connected) {
          const cmd = command.startsWith("/") ? command : `/${command}`;
          bot.chat(cmd);
          addActivity(`[CHAT-FALLBACK] ${cmd}`);
          resolve(`OK (via bot chat)`);
        } else {
          resolve(`FAILED (RCON error: ${err.message})`);
        }
      }
    }
  });
}

// ── HTTP API ──
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  
  try {
    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method;

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204); res.end(); return;
    }

    if (method === "GET" && parts[0] === "status") {
      res.writeHead(200);
      res.end(JSON.stringify({
        connected,
        username: MC_USERNAME,
        position,
        biome,
        uptime: process.uptime(),
        rconReady: rcon.ready,
      }));
      return;
    }

    if (method === "GET" && parts[0] === "queue") {
      const queue = loadQueue();
      const pending = queue.filter(r => r.status === "pending");
      res.writeHead(200);
      res.end(JSON.stringify({ count: pending.length, requests: pending }));
      return;
    }

    if (method === "POST" && parts[0] === "queue" && parts[1]) {
      const body = await readBody(req);
      const { status, result } = JSON.parse(body);
      const queue = loadQueue();
      const idx = queue.findIndex(r => r.id === parts[1]);
      if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }
      queue[idx] = { ...queue[idx], status, result };
      saveQueue(queue);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, request: queue[idx] }));
      return;
    }

    if (method === "POST" && parts[0] === "chat") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { message } = JSON.parse(await readBody(req));
      const cleanMsg = stripColor(message);
      const shortMsg = cleanMsg.substring(0, 60);
      if (shortMsg.startsWith("[") || shortMsg.startsWith("Phase") || shortMsg.includes("Phase")) {
        buildPhase = shortMsg;
        addActivity(`Progress: ${shortMsg}`);
      }
      bot.chat(cleanMsg);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === "POST" && parts[0] === "command") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { command } = JSON.parse(await readBody(req));
      const result = await executeCommand(command);
      if (command.startsWith("fill") || command.startsWith("/fill")) {
        const p = command.split(" ");
        if (p.length >= 8) {
          buildPhase = `Bauen (${p[7]})...`;
          addActivity(`Fill: ${p[7]} at ${p[1]},${p[2]},${p[3]}`);
        }
      } else if (command.startsWith("setblock") || command.startsWith("/setblock")) {
        buildPhase = "Details setzen...";
      }
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    if (method === "POST" && parts[0] === "tp") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x, y, z } = JSON.parse(await readBody(req));
      await executeCommand(`tp ${MC_USERNAME} ${x} ${y} ${z}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === "GET" && parts[0] === "world") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x1, y1, z1, x2, y2, z2 } = Object.fromEntries(url.searchParams);
      const blocks = getBlocksInRegion(+x1, +y1, +z1, +x2, +y2, +z2);
      res.writeHead(200);
      res.end(JSON.stringify({ blocks }));
      return;
    }

    if (method === "GET" && parts[0] === "biome") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x, y, z } = Object.fromEntries(url.searchParams);
      const b = getBiomeAt(+x, +y, +z);
      res.writeHead(200);
      res.end(JSON.stringify({ biome: b }));
      return;
    }

    if (method === "GET" && parts[0] === "entities") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const radius = parseInt(url.searchParams.get("radius") || "50");
      const entities = scanEntities(radius);
      res.writeHead(200);
      res.end(JSON.stringify({ entities }));
      return;
    }

    if (method === "GET" && parts[0] === "player" && parts[1]) {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const player = bot.players[parts[1]];
      if (!player || !player.entity) {
        res.writeHead(200);
        res.end(JSON.stringify({ position: position, note: "Using bot position as fallback" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ 
        username: parts[1],
        position: {
          x: Math.round(player.entity.position.x),
          y: Math.round(player.entity.position.y),
          z: Math.round(player.entity.position.z),
        }
      }));
      return;
    }

    if (method === "POST" && parts[0] === "item") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { name } = JSON.parse(await readBody(req));
      safeChat(`/give @s ${name}`);
      await sleep(100);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === "GET" && parts[0] === "activity") {
      const limit = parseInt(url.searchParams.get("limit") || "30");
      res.writeHead(200);
      res.end(JSON.stringify({ 
        currentBuildId: currentBuildId?.slice(-6) || null,
        currentBuildRunning: !!currentBuildProcess,
        buildPhase: buildPhase || "idle",
        entries: recentActivity.slice(-limit)
      }));
      return;
    }

    // ── Phase 1: Structure Builder ──
    if (method === "POST" && parts[0] === "structure" && parts[1] === "build") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { structure } = JSON.parse(await readBody(req));
      const result = await buildStructure(structure);
      addActivity(`[BUILD] Structure built: ${result.commands_executed || 0} commands`);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // ── Phase 2: World State JSON ──
    if (method === "GET" && parts[0] === "world_json") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x1, y1, z1, x2, y2, z2 } = Object.fromEntries(url.searchParams);
      const result = getWorldStateJSON(+x1, +y1, +z1, +x2, +y2, +z2);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // ── Phase 3: Copy/Paste ──
    if (method === "POST" && parts[0] === "copy") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x1, y1, z1, x2, y2, z2 } = JSON.parse(await readBody(req));
      const result = await copyRegion(+x1, +y1, +z1, +x2, +y2, +z2);
      addActivity(`[COPY] Region copied: ${x1},${y1},${z1} → ${x2},${y2},${z2}`);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (method === "POST" && parts[0] === "paste") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x, y, z, rotation } = JSON.parse(await readBody(req));
      const result = await pasteRegion(+x, +y, +z, rotation || 0);
      addActivity(`[PASTE] Region pasted at ${x},${y},${z} (rot: ${rotation || 0})`);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // ── Phase 4: Structure Save/Load ──
    if (method === "POST" && parts[0] === "structure" && parts[1] === "save") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { name, x1, y1, z1, x2, y2, z2 } = JSON.parse(await readBody(req));
      const result = saveStructure(name, +x1, +y1, +z1, +x2, +y2, +z2);
      addActivity(`[SAVE] Structure saved: ${name} (${result.block_count} blocks)`);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (method === "POST" && parts[0] === "structure" && parts[1] === "load") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { name, x, y, z, rotation } = JSON.parse(await readBody(req));
      const result = await loadStructure(name, +x, +y, +z, rotation || 0);
      addActivity(`[LOAD] Structure loaded: ${name} at ${x},${y},${z}`);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (method === "GET" && parts[0] === "structures") {
      const result = listStructures();
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // ── Phase 5: Batch Operations ──
    if (method === "POST" && parts[0] === "replace") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x1, y1, z1, x2, y2, z2, from_block, to_block } = JSON.parse(await readBody(req));
      const result = await replaceBlocks(+x1, +y1, +z1, +x2, +y2, +z2, from_block, to_block);
      addActivity(`[REPLACE] ${from_block} → ${to_block}`);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (method === "POST" && parts[0] === "pattern") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x1, y1, z1, x2, y2, z2, pattern, blocks } = JSON.parse(await readBody(req));
      const result = await fillPattern(+x1, +y1, +z1, +x2, +y2, +z2, pattern, blocks);
      addActivity(`[PATTERN] ${pattern} applied`);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // ── Phase 6: Terrain Profile ──
    if (method === "GET" && parts[0] === "terrain_profile") {
      if (!connected) { res.writeHead(503); res.end(JSON.stringify({ error: "Bot not connected" })); return; }
      const { x1, z1, x2, z2 } = Object.fromEntries(url.searchParams);
      const result = getTerrainProfile(+x1, +z1, +x2, +z2);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // ── Phase 7: Style Library ──
    if (method === "GET" && parts[0] === "style" && parts[1]) {
      const result = getStyle(parts[1]);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (method === "GET" && parts[0] === "styles") {
      const result = listStyles();
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ── World State ──
function getBlocksInRegion(x1, y1, z1, x2, y2, z2) {
  const blocks = [];
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
  
  const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  if (volume > 50000) return { error: `Region too large: ${volume} blocks (max 50000)` };

  let airCount = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        try {
          const pos = getVec3(x, y, z);
          const block = bot.blockAt(pos);
          if (!block) continue;
          if (block.name === "air" || block.name === "void_air" || block.name === "cave_air") {
            airCount++;
            continue;
          }
          blocks.push({ x, y, z, name: block.name });
        } catch { continue; }
      }
    }
  }
  return { 
    region: { x1, y1, z1, x2, y2, z2 },
    nonAirBlocks: blocks.length, 
    airBlocks: airCount,
    blocks: blocks.slice(0, 5000),
    truncated: blocks.length > 5000
  };
}

function getBiomeAt(x, y, z) {
  try {
    const pos = getVec3(x, y, z);
    const block = bot.blockAt(pos);
    return block?.biome?.name || "unknown";
  } catch { return "unknown"; }
}

function scanEntities(radius) {
  const entities = Object.values(bot.entities || {});
  return entities
    .filter(e => {
      if (!e.position) return false;
      const dist = Math.sqrt(
        (e.position.x - position.x) ** 2 +
        (e.position.y - position.y) ** 2 +
        (e.position.z - position.z) ** 2
      );
      return dist <= radius;
    })
    .map(e => ({
      name: e.name || e.username || "unknown",
      type: e.type || "mob",
      x: Math.round(e.position.x),
      y: Math.round(e.position.y),
      z: Math.round(e.position.z),
    }));
}

// ── Structure Builder (Phase 1) ──

async function buildStructure(structure) {
  const origin = structure.origin;
  if (!origin || !Array.isArray(origin) || origin.length !== 3) {
    return { error: "Invalid origin. Must be [x, y, z]" };
  }
  
  const commands = [];
  
  for (const layer of structure.layers || []) {
    const absY = origin[1] + (layer.y_offset || 0);
    const x1 = origin[0];
    const z1 = origin[2];
    const size = layer.size || [1, 1, 1];
    const x2 = x1 + size[0] - 1;
    const z2 = z1 + size[2] - 1;
    const block = layer.block || "stone";
    
    if (layer.type === "solid" || layer.type === "floor") {
      commands.push(`/fill ${x1} ${absY} ${z1} ${x2} ${absY + size[1] - 1} ${z2} ${block}`);
    } else if (layer.type === "hollow") {
      commands.push(`/fill ${x1} ${absY} ${z1} ${x2} ${absY + size[1] - 1} ${z2} ${block} hollow`);
    } else if (layer.type === "roof") {
      for (let i = 0; i < size[1]; i++) {
        const rx1 = x1 + i;
        const rx2 = x2 - i;
        const rz1 = z1 + i;
        const rz2 = z2 - i;
        if (rx1 > rx2 || rz1 > rz2) break;
        commands.push(`/fill ${rx1} ${absY + i} ${rz1} ${rx2} ${absY + i} ${rz2} ${block}`);
      }
    } else if (layer.type === "frame") {
      commands.push(`/fill ${x1} ${absY} ${z1} ${x1} ${absY + size[1] - 1} ${z1} ${block}`);
      commands.push(`/fill ${x2} ${absY} ${z1} ${x2} ${absY + size[1] - 1} ${z1} ${block}`);
      commands.push(`/fill ${x1} ${absY} ${z2} ${x1} ${absY + size[1] - 1} ${z2} ${block}`);
      commands.push(`/fill ${x2} ${absY} ${z2} ${x2} ${absY + size[1] - 1} ${z2} ${block}`);
      commands.push(`/fill ${x1} ${absY} ${z1} ${x2} ${absY} ${z1} ${block}`);
      commands.push(`/fill ${x1} ${absY} ${z2} ${x2} ${absY} ${z2} ${block}`);
      commands.push(`/fill ${x1} ${absY + size[1] - 1} ${z1} ${x2} ${absY + size[1] - 1} ${z1} ${block}`);
      commands.push(`/fill ${x1} ${absY + size[1] - 1} ${z2} ${x2} ${absY + size[1] - 1} ${z2} ${block}`);
    }
    
    for (const opening of layer.openings || []) {
      const ox = origin[0] + (opening.pos?.[0] || 0);
      const oy = absY + (opening.pos?.[1] || 0);
      const oz = origin[2] + (opening.pos?.[2] || 0);
      const oSize = opening.size || [1, 1, 1];
      commands.push(`/fill ${ox} ${oy} ${oz} ${ox + oSize[0] - 1} ${oy + oSize[1] - 1} ${oz + oSize[2] - 1} air`);
    }
  }
  
  for (const item of structure.interior || []) {
    const ix = origin[0] + (item.pos?.[0] || 0);
    const iy = origin[1] + (item.pos?.[1] || 0);
    const iz = origin[2] + (item.pos?.[2] || 0);
    commands.push(`/setblock ${ix} ${iy} ${iz} ${item.block || "air"}`);
  }
  
  for (const item of structure.exterior || []) {
    const ex = origin[0] + (item.pos?.[0] || 0);
    const ey = origin[1] + (item.pos?.[1] || 0);
    const ez = origin[2] + (item.pos?.[2] || 0);
    commands.push(`/setblock ${ex} ${ey} ${ez} ${item.block || "air"}`);
  }
  
  for (const cmd of commands) {
    await executeCommand(cmd);
    await sleep(30);
  }
  
  return { success: true, commands_executed: commands.length };
}

// ── World State JSON (Phase 2) ──

function getWorldStateJSON(x1, y1, z1, x2, y2, z2) {
  const blocks = [];
  const blockCounts = {};
  let airCount = 0;
  
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
  
  const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  if (volume > 50000) return { error: `Region too large: ${volume} blocks (max 50000)` };
  
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        try {
          const block = bot.blockAt(getVec3(x, y, z));
          if (!block || block.name === "air" || block.name === "void_air" || block.name === "cave_air") {
            airCount++;
            continue;
          }
          blocks.push({ x, y, z, name: block.name });
          blockCounts[block.name] = (blockCounts[block.name] || 0) + 1;
        } catch { continue; }
      }
    }
  }
  
  const surfaceBlocks = [];
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let y = maxY; y >= minY; y--) {
        try {
          const block = bot.blockAt(getVec3(x, y, z));
          if (block && block.name !== "air" && block.name !== "void_air" && block.name !== "cave_air") {
            surfaceBlocks.push({ x, y, z, name: block.name });
            break;
          }
        } catch { continue; }
      }
    }
  }
  
  return {
    dimensions: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
    total_blocks: blocks.length,
    air_blocks: airCount,
    block_counts: blockCounts,
    surface: surfaceBlocks,
    blocks: blocks.slice(0, 2000),
    terrain_profile: getTerrainProfile(minX, minZ, maxX, maxZ)
  };
}

// ── Terrain Profile (Phase 6) ──

function getTerrainProfile(x1, z1, x2, z2) {
  const profile = [];
  
  for (let x = x1; x <= x2; x++) {
    for (let z = z1; z <= z2; z++) {
      for (let y = 320; y >= -64; y--) {
        try {
          const block = bot.blockAt(getVec3(x, y, z));
          if (block && block.name !== "air" && block.name !== "void_air" && block.name !== "cave_air") {
            profile.push({ x, z, surface_y: y, block: block.name });
            break;
          }
        } catch { continue; }
      }
    }
  }
  
  if (profile.length === 0) {
    return { profile: [], stats: { min_height: 0, max_height: 0, avg_height: 0, variation: 0 }, is_flat: true };
  }
  
  const heights = profile.map(p => p.surface_y);
  const minH = Math.min(...heights);
  const maxH = Math.max(...heights);
  const avgH = Math.round(heights.reduce((a, b) => a + b, 0) / heights.length);
  
  return {
    profile,
    stats: { min_height: minH, max_height: maxH, avg_height: avgH, variation: maxH - minH },
    is_flat: (maxH - minH) <= 2
  };
}

// ── Copy/Paste (Phase 3) ──

async function copyRegion(x1, y1, z1, x2, y2, z2) {
  await executeCommand(`//pos1 ${x1},${y1},${z1}`);
  await sleep(100);
  await executeCommand(`//pos2 ${x2},${y2},${z2}`);
  await sleep(100);
  const result = await executeCommand(`//copy`);
  return { success: true, region: [x1, y1, z1, x2, y2, z2], result };
}

async function pasteRegion(x, y, z, rotation = 0) {
  await executeCommand(`//tp ${MC_USERNAME} ${x} ${y} ${z}`);
  await sleep(200);
  if (rotation !== 0) {
    await executeCommand(`//rotate ${rotation}`);
    await sleep(100);
  }
  const result = await executeCommand(`//paste`);
  return { success: true, position: [x, y, z], rotation, result };
}

// ── Structure Save/Load (Phase 4) ──

function saveStructure(name, x1, y1, z1, x2, y2, z2) {
  if (!fs.existsSync(STRUCTURES_DIR)) {
    fs.mkdirSync(STRUCTURES_DIR, { recursive: true });
  }
  
  const blocks = [];
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
  
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        try {
          const block = bot.blockAt(getVec3(x, y, z));
          if (block && block.name !== "air" && block.name !== "void_air" && block.name !== "cave_air") {
            blocks.push({
              x: x - minX,
              y: y - minY,
              z: z - minZ,
              name: block.name
            });
          }
        } catch { continue; }
      }
    }
  }
  
  const structure = {
    name,
    dimensions: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
    blocks,
    created: new Date().toISOString()
  };
  
  const filePath = path.join(STRUCTURES_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(structure, null, 2));
  return { success: true, path: filePath, block_count: blocks.length };
}

async function loadStructure(name, x, y, z, rotation = 0) {
  const filePath = path.join(STRUCTURES_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    return { error: `Structure '${name}' not found` };
  }
  
  const structure = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const commands = [];
  
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const block of structure.blocks) {
    let [bx, by, bz] = [block.x, block.y, block.z];
    
    if (rotation === 90) { [bx, bz] = [-bz, bx]; }
    else if (rotation === 180) { [bx, bz] = [-bx, -bz]; }
    else if (rotation === 270) { [bx, bz] = [bz, -bx]; }
    
    minX = Math.min(minX, bx);
    minZ = Math.min(minZ, bz);
    maxX = Math.max(maxX, bx);
    maxZ = Math.max(maxZ, bz);
  }
  
  const offsetX = minX < 0 ? -minX : 0;
  const offsetZ = minZ < 0 ? -minZ : 0;
  
  for (const block of structure.blocks) {
    let [bx, by, bz] = [block.x, block.y, block.z];
    
    if (rotation === 90) { [bx, bz] = [-bz, bx]; }
    else if (rotation === 180) { [bx, bz] = [-bx, -bz]; }
    else if (rotation === 270) { [bx, bz] = [bz, -bx]; }
    
    commands.push(`/setblock ${x + bx + offsetX} ${y + by} ${z + bz + offsetZ} ${block.name}`);
  }
  
  for (const cmd of commands) {
    await executeCommand(cmd);
    await sleep(20);
  }
  
  return { success: true, blocks_placed: commands.length };
}

function listStructures() {
  if (!fs.existsSync(STRUCTURES_DIR)) {
    return { structures: [] };
  }
  
  const files = fs.readdirSync(STRUCTURES_DIR).filter(f => f.endsWith(".json"));
  const structures = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STRUCTURES_DIR, f), "utf-8"));
      return {
        name: data.name || f.replace(".json", ""),
        dimensions: data.dimensions,
        block_count: data.blocks?.length || 0,
        created: data.created
      };
    } catch { return { name: f.replace(".json", ""), error: "Could not read" }; }
  });
  
  return { structures };
}

// ── Batch Operations (Phase 5) ──

async function replaceBlocks(x1, y1, z1, x2, y2, z2, fromBlock, toBlock) {
  const result = await executeCommand(
    `/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${toBlock} replace ${fromBlock}`
  );
  return { success: true, result };
}

async function fillPattern(x1, y1, z1, x2, y2, z2, pattern, blocks) {
  if (!blocks || blocks.length === 0) {
    return { error: "No blocks provided for pattern" };
  }
  
  const commands = [];
  
  if (pattern === "checkerboard") {
    for (let y = y1; y <= y2; y++) {
      for (let z = z1; z <= z2; z++) {
        for (let x = x1; x <= x2; x++) {
          const idx = ((x - x1) + (z - z1)) % 2;
          commands.push(`/setblock ${x} ${y} ${z} ${blocks[idx % blocks.length]}`);
        }
      }
    }
  } else if (pattern === "stripes_x") {
    for (let x = x1; x <= x2; x++) {
      const block = blocks[(x - x1) % blocks.length];
      commands.push(`/fill ${x} ${y1} ${z1} ${x} ${y2} ${z2} ${block}`);
    }
  } else if (pattern === "stripes_z") {
    for (let z = z1; z <= z2; z++) {
      const block = blocks[(z - z1) % blocks.length];
      commands.push(`/fill ${x1} ${y1} ${z} ${x2} ${y2} ${z} ${block}`);
    }
  } else if (pattern === "random_mix") {
    for (let y = y1; y <= y2; y++) {
      for (let z = z1; z <= z2; z++) {
        for (let x = x1; x <= x2; x++) {
          const block = blocks[Math.floor(Math.random() * blocks.length)];
          commands.push(`/setblock ${x} ${y} ${z} ${block}`);
        }
      }
    }
  } else {
    return { error: `Unknown pattern: ${pattern}` };
  }
  
  for (const cmd of commands) {
    await executeCommand(cmd);
    await sleep(20);
  }
  
  return { success: true, commands: commands.length };
}

// ── Style Library (Phase 7) ──

function getStyle(name) {
  const filePath = path.join(STYLES_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    const available = fs.existsSync(STYLES_DIR) 
      ? fs.readdirSync(STYLES_DIR).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""))
      : [];
    return { error: `Style '${name}' not found. Available: ${available.join(", ") || "none"}` };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function listStyles() {
  if (!fs.existsSync(STYLES_DIR)) {
    return { styles: [] };
  }
  
  const files = fs.readdirSync(STYLES_DIR).filter(f => f.endsWith(".json"));
  const styles = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STYLES_DIR, f), "utf-8"));
      return {
        name: data.name || f.replace(".json", ""),
        description: data.description || "",
        colors: data.colors || []
      };
    } catch { return { name: f.replace(".json", ""), error: "Could not read" }; }
  });
  
  return { styles };
}

// ── Build Processing ──

function spawnOpenCode(request) {
  const pos = `${request.position.x},${request.position.y},${request.position.z}`;
  const prompt = `${request.player} wants "${request.prompt}" at ${pos}. Build it. Mark done: mc_mark_build_done("${request.id}","completed","summary")`;

  addActivity(`Spawning opencode for #${request.id.slice(-6)}: "${request.prompt}"`);

  currentBuildProcess = spawn(OPENCODE_BIN, [
    "run",
    "--agent", "mc-orchestrator",
    "--dangerously-skip-permissions",
    prompt
  ], {
    cwd: PROJECT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";

  currentBuildProcess.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      fs.appendFileSync(BUILD_LOG_FILE, `[AI-OUT] ${trimmed}\n`);

      // Parse MCP tool calls for readable logging
      if (trimmed.includes("mc_fill_region")) {
        const match = trimmed.match(/"x1":\s*(-?\d+).*"y1":\s*(-?\d+).*"z1":\s*(-?\d+).*"x2":\s*(-?\d+).*"y2":\s*(-?\d+).*"z2":\s*(-?\d+).*"blockType":\s*"([^"]+)"/);
        if (match) {
          const [, x1, y1, z1, x2, y2, z2, block] = match;
          addActivity(`[AI] Fülle ${x1},${y1},${z1} → ${x2},${y2},${z2} mit ${block}`);
        }
      }
      if (trimmed.includes("mc_setblock")) {
        const match = trimmed.match(/"x":\s*(-?\d+).*"y":\s*(-?\d+).*"z":\s*(-?\d+).*"blockType":\s*"([^"]+)"/);
        if (match) {
          const [, x, y, z, block] = match;
          addActivity(`[AI] Setze ${block} bei ${x},${y},${z}`);
        }
      }
      if (trimmed.includes("mc_send_chat")) {
        const match = trimmed.match(/"message":\s*"([^"]+)"/);
        if (match) {
          buildPhase = match[1].substring(0, 40);
          addActivity(`[AI-CHAT] ${match[1]}`);
        }
      }
      if (trimmed.includes("mc_mark_build_done")) {
        addActivity(`[AI] Build abschließen...`);
      }

      // Chat-Output für Minecraft (gefiltert)
      const chatLine = trimmed.substring(0, 55);
      if (chatLine.length > 5 && !chatLine.startsWith("{") && !chatLine.startsWith("[")) {
        safeChat(chatLine);
      }
    }
  });

  currentBuildProcess.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (!text) return;
    fs.appendFileSync(BUILD_LOG_FILE, `[AI-ERR] ${text}\n`);
    console.error(`[AI-ERR] ${text.substring(0, 200)}`);
  });

  currentBuildProcess.on("close", (code) => {
    addActivity(`Build #${request.id.slice(-6)} FINISHED (exit ${code})`);

    const q = loadQueue();
    const idx = q.findIndex(r => r.id === request.id);
    if (idx >= 0 && q[idx].status === "building") {
      q[idx].status = code === 0 ? "completed" : "failed";
      q[idx].result = code === 0 ? "Build abgeschlossen" : `Fehlgeschlagen (exit ${code})`;
      saveQueue(q);
    }

    currentBuildProcess = null;
    currentBuildId = null;
    buildPhase = "";

    if (bot && connected) {
      safeChat(`Build #${request.id.slice(-6)} ${code === 0 ? "abgeschlossen!" : "fehlgeschlagen."} !build fuer neuen Auftrag`);
    }
  });

  currentBuildProcess.on("error", (err) => {
    addActivity(`Build #${request.id.slice(-6)} PROCESS ERROR: ${err.message}`);
    currentBuildProcess = null;
    currentBuildId = null;
    buildPhase = "";
    if (bot && connected) {
      safeChat(`Build #${request.id.slice(-6)} Fehler: ${err.message}`);
    }
  });
}

// ── Startup ──
try {
  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, "[]", { mode: 0o664 });
    fs.chmodSync(QUEUE_FILE, 0o664);
  }
  if (!fs.existsSync(BUILD_LOG_FILE)) {
    fs.writeFileSync(BUILD_LOG_FILE, "", { mode: 0o664 });
    fs.chmodSync(BUILD_LOG_FILE, 0o664);
  }
  if (!fs.existsSync(STRUCTURES_DIR)) {
    fs.mkdirSync(STRUCTURES_DIR, { recursive: true });
  }
  if (!fs.existsSync(STYLES_DIR)) {
    fs.mkdirSync(STYLES_DIR, { recursive: true });
  }
} catch (_) {}

addActivity("SYSTEM: Bot daemon v3 starting...");
console.log("[BotDaemon] Starting bot daemon v3 (persistent RCON)...");
createBot();

rcon.connect().then(() => {
  console.log("[BotDaemon] RCON connected");
}).catch((err) => {
  console.error(`[BotDaemon] RCON initial connect failed: ${err.message} — will retry`);
});

server.listen(HTTP_PORT, "127.0.0.1", () => {
  addActivity("SYSTEM: Bot daemon v4 starting...");
  console.log(`[BotDaemon] HTTP API on http://127.0.0.1:${HTTP_PORT}`);
  console.log("[BotDaemon] Endpoints: GET /status, /queue, /world, /world_json, /biome, /entities, /player/:name, /activity, /terrain_profile, /structures, /style/:name, /styles");
  console.log("[BotDaemon]            POST /chat, /command, /tp, /item, /queue/:id, /structure/build, /structure/save, /structure/load, /copy, /paste, /replace, /pattern");
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on("SIGINT", () => { 
  try { if (bot) bot.quit(); } catch(_) {} 
  rcon.destroy();
  process.exit(0); 
});
process.on("SIGTERM", () => { 
  try { if (bot) bot.quit(); } catch(_) {} 
  rcon.destroy();
  process.exit(0); 
});
