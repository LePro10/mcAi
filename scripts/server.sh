#!/usr/bin/env bash
# mcAI dedicated server (Fabric 26.3 + mcAI). Usually called as `./mcai server <cmd>`.
#
#   start [--offline|--online] [--port N] [--accept-eula] [--no-engine]
#   stop | restart | status | logs [-f] | console | cmd <command…>
#
# Directory: $MCAI_SERVER_DIR or <repo>/server (gitignored). Heap: $MCAI_SERVER_XMX (default 4G).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

DIR="${MCAI_SERVER_DIR:-$ROOT/server}"
PIDFILE="$DIR/server.pid"
FIFO="$DIR/console.in"
LOG="$DIR/logs/latest.log"
OUT="$DIR/console.out"
XMX="${MCAI_SERVER_XMX:-4G}"
XMS="${MCAI_SERVER_XMS:-1G}"

running() { [[ -f "$PIDFILE" ]] && pid_alive "$(cat "$PIDFILE")"; }
prop() { sed -n "s/^$1=//p" "$DIR/server.properties" 2>/dev/null | head -n1; }

# Aikar's widely used G1 flags for Minecraft servers (minus AlwaysPreTouch: slow start, pins RAM on a laptop).
JVM_FLAGS=(
  -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions
  -XX:+DisableExplicitGC -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M
  -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4
  -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:SurvivorRatio=32
  -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1
)

start() {
  local setup_args=() engine=1
  while (($#)); do
    case "$1" in
      --offline|--online|--accept-eula|--dry-run) setup_args+=("$1") ;;
      --port) [[ $# -ge 2 ]] || die "--port needs a value" 2; setup_args+=(--port "$2"); shift ;;
      --port=*) setup_args+=(--port "${1#*=}") ;;
      --no-engine) engine=0 ;;
      *) die "unknown option for 'server start': $1" 2 "./mcai server help" ;;
    esac
    shift
  done
  if running; then ok "server already running (pid $(cat "$PIDFILE"), port $(prop server-port))"; return 0; fi
  need_node
  need_java
  step "Installing / updating the server in $DIR"
  "$NODE" "$ROOT/scripts/setup-server.mjs" --dir "$DIR" "${setup_args[@]+"${setup_args[@]}"}" || exit $?
  local port; port=$(prop server-port); port=${port:-25565}
  if command -v lsof >/dev/null && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $port is already in use" 1 "stop the other server, or: ./mcai server start --port 25566"
  fi
  if ((engine)); then
    step "Engine"
    MCAI_CMD="server start" engine_start minecraft
  fi
  step "Starting the server"
  mkdir -p "$DIR/logs"
  rm -f "$FIFO" "$LOG"
  mkfifo "$FIFO"
  # fd 3 keeps the console FIFO open read-write: `cmd` never blocks and the server never sees EOF.
  (
    cd "$DIR"
    exec 3<>"$FIFO"
    exec nohup "$JAVA_BIN" "-Xms$XMS" "-Xmx$XMX" "${JVM_FLAGS[@]}" -jar fabric-server-launch.jar nogui <&3 >"$OUT" 2>&1
  ) &
  echo $! > "$PIDFILE"
  info "pid $!, Java $JAVA_HOME_FOUND, heap ${XMS}…${XMX} — waiting for the world to load"
  local i
  for i in $(seq 1 360); do
    running || { tail -n 40 "$OUT" >&2; rm -f "$PIDFILE" "$FIFO"; die "the server exited during startup (see $OUT)"; }
    if grep -q 'Done (' "$LOG" 2>/dev/null; then
      ok "$(grep -m1 -o 'Done ([^)]*)!.*' "$LOG")"
      local n; n=$(grep -m1 -oE 'Loading [0-9]+ mods' "$LOG" || true)
      [[ -n "$n" ]] && info "$n"
      grep -qE 'mcai' "$LOG" && info "mcAI mod loaded"
      printf '\n  %sJoin:%s Multiplayer → Add Server → %s127.0.0.1:%s%s (others: this computer'"'"'s LAN IP)\n' "$B" "$N" "$B" "$port" "$N"
      [[ "$(prop online-mode)" == false ]] && warn "offline mode (no account check) — trusted LAN only"
      info "make yourself operator:  ./mcai server cmd op <your name>"
      return 0
    fi
    sleep 0.5
  done
  die "the server did not finish loading within 180 s" 1 "./mcai server logs"
}

stop() {
  if ! running; then info "server not running"; rm -f "$PIDFILE" "$FIFO"; return 0; fi
  local pid; pid=$(cat "$PIDFILE")
  info "stopping the server (saving the world) …"
  if grep -q 'Done (' "$LOG" 2>/dev/null; then echo stop > "$FIFO" || true
  else kill -TERM "$pid" 2>/dev/null || true; fi   # still booting: console commands are not read yet; the JVM shutdown hook saves
  local i
  for i in $(seq 1 120); do pid_alive "$pid" || break; sleep 0.5; done
  if pid_alive "$pid"; then warn "no clean shutdown after 60 s — SIGTERM"; kill -TERM "$pid" 2>/dev/null || true; sleep 10; fi
  if pid_alive "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f "$PIDFILE" "$FIFO"
  ok "server stopped"
}

status() {
  if running; then
    local st="booting…"
    grep -q 'Done (' "$LOG" 2>/dev/null && st="ready"
    ok "server running (pid $(cat "$PIDFILE"), port $(prop server-port), online-mode $(prop online-mode)) — $st"
    local m; m=$(grep -E 'mcai: (connected|handshake|engine connection lost|waiting)' "$LOG" 2>/dev/null | tail -n1 | sed 's/^.*\]: //' || true)
    [[ -n "$m" ]] && info "$m"
    return 0
  fi
  info "server not running ${D}($DIR)${N}"
  return 3
}

console() {
  running || die "server not running" 1 "./mcai server start"
  printf '%sServer console%s — type commands without "/", %sCtrl-D%s leaves the console (the server keeps running).\n' "$B" "$N" "$B" "$N"
  tail -n 20 -f "$LOG" &
  local tp=$!
  trap 'kill $tp 2>/dev/null' EXIT INT TERM
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    running || { warn "server stopped"; break; }
    printf '%s\n' "${line#/}" > "$FIFO"
  done
}

case "${1:-help}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  restart) shift; stop; start "$@" ;;
  status) status ;;
  logs) if [[ "${2:-}" == "-f" ]]; then tail -n 50 -f "$LOG"; else tail -n 100 "$LOG"; fi ;;
  console) console ;;
  cmd) shift; running || die "server not running" 1 "./mcai server start"; [[ $# -gt 0 ]] || die "usage: ./mcai server cmd <command>" 2; c="$*"; n=$(wc -l < "$LOG"); printf '%s\n' "${c#/}" > "$FIFO"; sleep 0.8; tail -n +"$((n + 1))" "$LOG" ;;
  help|-h|--help)
    cat <<EOF
${B}./mcai server${N} — dedicated multiplayer server (Fabric 26.3 + mcAI), directory ${DIR/#$HOME/~}

  start [--offline|--online] [--port N] [--accept-eula] [--no-engine]
                    install/update (server.jar, Fabric, mods), start the engine + server
  stop              save the world and stop
  restart           stop + start
  status            running? ready? engine connected?
  logs [-f]         server log
  console           interactive console (Ctrl-D to leave)
  cmd <command>     run one console command, e.g. ./mcai server cmd op Steve

  EULA: you must accept https://aka.ms/MinecraftEULA yourself (--accept-eula or MCAI_ACCEPT_EULA=1).
  env:  MCAI_SERVER_DIR, MCAI_SERVER_XMX (4G), MCAI_SERVER_XMS (1G)
EOF
    ;;
  *) die "unknown server command '$1'" 2 "./mcai server help" ;;
esac
