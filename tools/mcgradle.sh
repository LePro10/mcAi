#!/usr/bin/env bash
# Run the mod's Gradle build through the local verified Minecraft mirror (for networks that
# block Mojang's hosts). Starts tools/mc-mirror.mjs if it is not already running.
#
#   tools/mcgradle.sh build            # = (cd mod && ./gradlew build) with MCAI_MC_MIRROR set
#   MCAI_MC_MIRROR_PORT=8790 tools/mcgradle.sh runServer
#
# Prerequisite: node tools/mc-fetch.mjs 26.3  (downloads + sha1-verifies everything once).
# With normal internet access you do not need this script: plain ./gradlew works.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${MCAI_MC_MIRROR_PORT:-8790}"
export MCAI_MC_MIRROR="http://127.0.0.1:$PORT"
export JAVA_HOME="${JAVA_HOME:-$HOME/.mcai-tools/jdk-25.0.5+8/Contents/Home}"

if ! curl -fsS -m 2 "$MCAI_MC_MIRROR/status" >/dev/null 2>&1; then
  node "$ROOT/tools/mc-mirror.mjs" --port "$PORT" >"${TMPDIR:-/tmp}/mcai-mc-mirror.log" 2>&1 &
  MIRROR_PID=$!
  trap 'kill $MIRROR_PID 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do
    curl -fsS -m 1 "$MCAI_MC_MIRROR/status" >/dev/null 2>&1 && break
    sleep 0.1
  done
fi
curl -fsS -m 2 "$MCAI_MC_MIRROR/status" | grep -q '"26.3"' || {
  echo "mc-mirror has no verified 26.3 — run: node tools/mc-fetch.mjs 26.3" >&2
  exit 1
}

cd "$ROOT/mod"
./gradlew "$@"
