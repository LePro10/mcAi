#!/usr/bin/env bash
# Local headless Fabric dedicated server for testing the mcai mod (production layout).
#
#   tools/testserver.sh start [--fresh]   install/update mods, start in background, wait for "Done ("
#   tools/testserver.sh stop              graceful stop (console "stop", then SIGTERM, then SIGKILL)
#   tools/testserver.sh status            running? booted? engine connected?
#   tools/testserver.sh logs [-f]         last 100 log lines (or follow)
#   tools/testserver.sh cmd <command...>  send a console command (e.g. "say hi", "list")
#
# Layout: tools/testserver/ (gitignored)
#   server.jar                 vanilla server, copied from the sha1-verified mc-fetch cache
#   fabric-server-launch.jar   Fabric server launcher (loader 0.20.1, cached in ~/.mcai-tools/fabric)
#   mods/                      mcai-<version>.jar (mod/build/libs) + fabric-api (maven.fabricmc.net, sha1-verified)
#
# EULA: running a Minecraft server requires accepting the Minecraft EULA
# (https://aka.ms/MinecraftEULA). This script never accepts it for you: if eula.txt is not
# already eula=true, start only proceeds with MCAI_ACCEPT_EULA=1 (meaning *you* accept it).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/tools/testserver"
JAVA_HOME="${JAVA_HOME:-$HOME/.mcai-tools/jdk-25.0.5+8/Contents/Home}"
JAVA="$JAVA_HOME/bin/java"
CACHE="${MCAI_MC_CACHE:-$HOME/.mcai-tools/mc}"
FABRIC_CACHE="$HOME/.mcai-tools/fabric"
MC_VERSION=26.3
SERVER_SHA1=33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c
LOADER_VERSION=$(sed -n 's/^loader_version=//p' "$ROOT/mod/gradle.properties")
FABRIC_API_VERSION=$(sed -n 's/^fabric_api_version=//p' "$ROOT/mod/gradle.properties")
MOD_VERSION=$(sed -n 's/^version=//p' "$ROOT/mod/gradle.properties")
LAUNCHER_VERSION=1.1.2
LAUNCHER="$FABRIC_CACHE/fabric-server-$MC_VERSION-$LOADER_VERSION-$LAUNCHER_VERSION.jar"
PORT="${MCAI_TESTSERVER_PORT:-25565}"
XMX="${MCAI_TESTSERVER_XMX:-4G}"
PIDFILE="$DIR/server.pid"
FIFO="$DIR/console.in"
LOG="$DIR/logs/latest.log"
OUT="$DIR/console.out"

die() { echo "testserver: $*" >&2; exit 1; }
sha1() { shasum -a 1 "$1" | cut -d' ' -f1; }
running() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

# Download $1 to $2 and verify against the maven's own .sha1 (HTTPS).
maven_fetch() {
  local url="$1" dest="$2" want
  want=$(curl -fsSL --retry 3 "$url.sha1" | tr -d ' \n' | cut -c1-40) || die "cannot fetch $url.sha1"
  if [[ -f "$dest" && "$(sha1 "$dest")" == "$want" ]]; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  curl -fsSL --retry 3 -o "$dest.part" "$url" || die "cannot download $url"
  [[ "$(sha1 "$dest.part")" == "$want" ]] || { rm -f "$dest.part"; die "sha1 mismatch for $url"; }
  mv "$dest.part" "$dest"
}

set_prop() { # key value — set or add a server.properties entry
  local f="$DIR/server.properties"
  if grep -q "^$1=" "$f" 2>/dev/null; then
    sed -i '' "s|^$1=.*|$1=$2|" "$f"
  else
    echo "$1=$2" >> "$f"
  fi
}

install() {
  mkdir -p "$DIR/mods" "$DIR/logs"
  # vanilla server jar (verified)
  local src="$CACHE/piston-data/v1/objects/$SERVER_SHA1/server.jar"
  if [[ ! -f "$DIR/server.jar" || "$(sha1 "$DIR/server.jar")" != "$SERVER_SHA1" ]]; then
    [[ -f "$src" ]] || die "server.jar missing — run: node tools/mc-fetch.mjs $MC_VERSION"
    [[ "$(sha1 "$src")" == "$SERVER_SHA1" ]] || die "cached server.jar fails sha1 verification"
    cp "$src" "$DIR/server.jar"
  fi
  # Fabric server launcher (from meta.fabricmc.net; cached because meta may be unreachable)
  if [[ ! -f "$LAUNCHER" ]]; then
    curl -fsSL -o "$LAUNCHER.part" "https://meta.fabricmc.net/v2/versions/loader/$MC_VERSION/$LOADER_VERSION/$LAUNCHER_VERSION/server/jar" \
      && mv "$LAUNCHER.part" "$LAUNCHER" || die "Fabric server launcher not cached and meta.fabricmc.net unreachable: $LAUNCHER"
  fi
  cp "$LAUNCHER" "$DIR/fabric-server-launch.jar"
  echo "serverJar=server.jar" > "$DIR/fabric-server-launcher.properties"
  # mods
  local api="fabric-api-$FABRIC_API_VERSION.jar"
  maven_fetch "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/${FABRIC_API_VERSION//+/%2B}/${api//+/%2B}" "$FABRIC_CACHE/$api"
  local mod="$ROOT/mod/build/libs/mcai-$MOD_VERSION.jar"
  [[ -f "$mod" ]] || die "mod jar missing — build it: (cd mod && ./gradlew build)"
  rm -f "$DIR"/mods/fabric-api-*.jar "$DIR"/mods/mcai-*.jar
  cp "$FABRIC_CACHE/$api" "$mod" "$DIR/mods/"
  # EULA
  if ! grep -q '^eula=true' "$DIR/eula.txt" 2>/dev/null; then
    [[ "${MCAI_ACCEPT_EULA:-}" == 1 ]] || die "the Minecraft EULA (https://aka.ms/MinecraftEULA) is not accepted for $DIR.
  Read it; if you accept it, run again with MCAI_ACCEPT_EULA=1."
    printf '# Accepted by the operator via MCAI_ACCEPT_EULA=1 (https://aka.ms/MinecraftEULA)\neula=true\n' > "$DIR/eula.txt"
  fi
  # properties for a local, offline, flat dev server
  touch "$DIR/server.properties"
  set_prop online-mode false
  set_prop white-list false
  set_prop server-port "$PORT"
  set_prop spawn-protection 0
  set_prop enable-rcon false
  set_prop pause-when-empty-seconds 0
  set_prop view-distance 6
  set_prop simulation-distance 4
  set_prop motd "mcAI test server"
  if [[ ! -d "$DIR/world" ]]; then
    set_prop level-type 'minecraft\:flat'
    set_prop generate-structures false
    set_prop generator-settings '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}'
  fi
}

start() {
  running && { echo "already running (pid $(cat "$PIDFILE"))"; return 0; }
  [[ -x "$JAVA" ]] || die "java not found at $JAVA (set JAVA_HOME)"
  [[ "${1:-}" == "--fresh" ]] && rm -rf "$DIR/world"
  install
  rm -f "$FIFO" "$LOG"
  mkfifo "$FIFO"
  # fd 3 keeps the console FIFO open read-write, so `cmd` never blocks and EOF never arrives.
  (
    cd "$DIR"
    exec 3<>"$FIFO"
    exec nohup "$JAVA" -Xms1G -Xmx"$XMX" -XX:+UseG1GC -jar fabric-server-launch.jar nogui <&3 >"$OUT" 2>&1
  ) &
  echo $! > "$PIDFILE"
  echo "starting (pid $!), waiting for boot…"
  for _ in $(seq 1 240); do
    running || { tail -n 40 "$OUT"; die "server exited during startup"; }
    if grep -q 'Done (' "$LOG" 2>/dev/null; then
      grep -m1 'Done (' "$LOG"
      return 0
    fi
    sleep 0.5
  done
  die "server did not finish booting within 120 s (see $LOG)"
}

stop() {
  running || { echo "not running"; rm -f "$PIDFILE"; return 0; }
  local pid; pid=$(cat "$PIDFILE")
  echo stop > "$FIFO" || true
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid"; sleep 5; fi
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; fi
  rm -f "$PIDFILE" "$FIFO"
  echo "stopped"
}

status() {
  if running; then
    echo "running (pid $(cat "$PIDFILE"))"
    grep -m1 'Done (' "$LOG" 2>/dev/null || echo "booting…"
    grep -E 'mcai: (connected|handshake|engine connection lost|waiting)' "$LOG" 2>/dev/null | tail -n 2 || true
  else
    echo "not running"
    return 1
  fi
}

case "${1:-}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  restart) stop; shift; start "$@" ;;
  status) status ;;
  logs) if [[ "${2:-}" == "-f" ]]; then tail -f "$LOG"; else tail -n 100 "$LOG"; fi ;;
  cmd) shift; running || die "not running"; echo "$*" > "$FIFO" ;;
  *) echo "usage: $0 start [--fresh] | stop | restart | status | logs [-f] | cmd <command>"; exit 2 ;;
esac
