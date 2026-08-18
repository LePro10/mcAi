#!/bin/bash
# ════════════════════════════════════════════════════════════
#  mcAI — Stop Script
#  Stoppt alle laufenden mcAI-Prozesse sauber.
# ════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║         mcAI — Shutting Down...             ║"
echo "╚══════════════════════════════════════════════╝"

kill_proc() {
  local name="$1"
  local pattern="$2"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "$pids" | while read pid; do
      [ "$pid" -le 1 ] 2>/dev/null && continue
      kill "$pid" 2>/dev/null && echo "  [OK] $name (PID $pid) gestoppt" || echo "  [--] $name (PID $pid) konnte nicht gestoppt werden"
    done
  else
    echo "  [--] $name nicht gefunden"
  fi
}

kill_proc "Bot Daemon"    "bot-daemon.mjs"
kill_proc "Watchdog"      "watchdog.sh"
kill_proc "Minecraft"     "paper.jar"
kill_proc "opencode"      "opencode"

sleep 2

# Force kill remaining
remaining=$(pgrep -f "bot-daemon.mjs|watchdog.sh|paper.jar|opencode" 2>/dev/null | grep -v "^$$\$" | grep -v "stop.sh" | head -5)
if [ -n "$remaining" ]; then
  echo ""
  echo "  Force kill läuft noch..."
  echo "$remaining" | while read pid; do
    [ "$pid" -le 1 ] 2>/dev/null && continue
    kill -9 "$pid" 2>/dev/null && echo "  [OK] PID $pid erzwungen gestoppt"
  done
fi

echo ""
echo "Alle Systeme gestoppt. Mit ./start.sh frisch starten."
