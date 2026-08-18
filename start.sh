#!/bin/bash
# ════════════════════════════════════════════════════════════
#  mcAI — Minecraft AI Builder (Full Auto)
#
#  Startet Minecraft Server + Bot Daemon im Hintergrund.
#  Nach dem Start: Joine Minecraft und tippe !build <prompt>
#  Stoppen: ./stop.sh
# ════════════════════════════════════════════════════════════

set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "╔══════════════════════════════════════════════╗"
echo "║         mcAI — Minecraft AI Builder         ║"
echo "║         v3 — Persistent RCON Mode            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Kill leftovers
for p in "paper.jar" "bot-daemon.mjs"; do
  pgrep -f "$p" 2>/dev/null | while read pid; do
    [ "$pid" -le 1 ] 2>/dev/null && continue
    kill "$pid" 2>/dev/null || true
  done
done
sleep 2

# ── 1. Minecraft Server ──

# Bot zu ops.json hinzufügen (offline mode UUID)
echo "  Adding AIBuilder to ops.json..."
python3 -c "
import json, hashlib, uuid

ops_file = '$PROJECT_DIR/server/ops.json'
try:
    with open(ops_file) as f:
        ops = json.load(f)
except:
    ops = []

# Offline mode UUID = MD5('OfflinePlayer:AIBuilder')
md5 = hashlib.md5('OfflinePlayer:AIBuilder'.encode()).hexdigest()
offline_uuid = str(uuid.UUID(md5))

if not any(op.get('name') == 'AIBuilder' for op in ops):
    ops.append({
        'uuid': offline_uuid,
        'name': 'AIBuilder',
        'level': 4,
        'bypassesPlayerLimit': False
    })
    with open(ops_file, 'w') as f:
        json.dump(ops, f, indent=2)
    print('  AIBuilder added to ops.json')
else:
    print('  AIBuilder already in ops.json')
"

echo "[1/2] Starting Minecraft Server (PaperMC 1.21.4)..."
cd "$PROJECT_DIR/server"
nohup java -Xmx4G -Xms1G -jar paper.jar nogui > server.log 2>&1 &
MC_PID=$!
disown $MC_PID

echo -n "  Waiting for server"
SERVER_READY=false
for i in $(seq 1 90); do
  if grep -q "Done (" server.log 2>/dev/null; then
    echo " ready (${i}s)"
    SERVER_READY=true
    break
  fi
  if ! kill -0 $MC_PID 2>/dev/null; then
    echo ""
    echo "  Minecraft Server ist abgestürzt! Letzte Log-Zeilen:"
    tail -5 server.log
    exit 1
  fi
  echo -n "."; sleep 1
done

if [ "$SERVER_READY" = false ]; then
  echo ""
  echo "  Fehler: Minecraft Server wurde nicht rechtzeitig fertig."
  tail -10 server.log 2>/dev/null
  exit 1
fi

# ── 2. Bot Daemon ──

echo "[2/2] Starting Bot Daemon (v3 — Persistent RCON)..."
cd "$PROJECT_DIR/mcp-minecraft"
nohup node bot-daemon.mjs > bot.log 2>&1 &
BOT_PID=$!
disown $BOT_PID

echo -n "  Waiting for bot"
BOT_READY=false
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8765/status > /dev/null 2>&1; then
    BOT_READY=true
    break
  fi
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo ""
    echo "  Bot Daemon ist abgestürzt!"
    tail -5 "$PROJECT_DIR/mcp-minecraft/bot.log" 2>/dev/null
    exit 1
  fi
  echo -n "."; sleep 1
done

if [ "$BOT_READY" = false ]; then
  echo ""
  echo "  Fehler: Bot Daemon wurde nicht rechtzeitig fertig."
  exit 1
fi

echo " ready (${i}s)"

# Gamemode setzen (Bot ist schon OP via ops.json)
echo -n "  Setting gamemode"
GM_READY=false
for i in $(seq 1 15); do
  STATUS=$(curl -s http://127.0.0.1:8765/status 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null || echo "False")
  if [ "$STATUS" = "True" ]; then
    sleep 2
    curl -s --max-time 5 -X POST http://127.0.0.1:8765/command \
      -H 'Content-Type: application/json' \
      -d '{"command":"/gamemode creative AIBuilder"}' > /dev/null 2>&1 || true
    echo " done"
    GM_READY=true
    break
  fi
  echo -n "."; sleep 1
done

if [ "$GM_READY" = false ]; then
  echo " timeout — will retry in background"
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║           ALL SYSTEMS READY                  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Minecraft Server : localhost:25565          ║"
echo "║  Bot (AIBuilder)  : OP, Creative             ║"
echo "║  RCON             : Persistent Connection    ║"
echo "║                                              ║"
echo "║  So funktioniert's:                          ║"
echo "║  1. Joine Minecraft (1.21.4, localhost)      ║"
echo "║  2. Chat: !build eine riesige Burg           ║"
echo "║  3. Bot baut autonom via RCON                ║"
echo "║  4. Fortschritt im Chat + bot.log            ║"
echo "║                                              ║"
echo "║  Stoppen: ./stop.sh                          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  System läuft im Hintergrund. !build im Minecraft-Chat nutzen."
echo "  Logs: tail -f mcp-minecraft/bot.log"
