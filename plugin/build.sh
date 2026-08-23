#!/usr/bin/env bash
# Build mcAI.jar.
#
# The jar contains two things: the plugin's own classes, and the engine — the
# Node program that holds the blueprint compiler — under engine/. Embedding it
# is what makes the install one file: the plugin unpacks it into
# plugins/mcAI/engine on first start, so nobody downloads a second thing or
# keeps two versions in step.
#
# In plugin mode the engine imports nothing outside Node's standard library
# (checked below), which is the only reason this is possible at all.
#
# Compiles against the stubs in stubs/ rather than the Paper artifact, which is
# not on Maven Central. The stubs are compile-time only: the real Bukkit comes
# from the server at runtime.
set -euo pipefail
cd "$(dirname "$0")"

ROOT=..
OUT=build
WITH_ENGINE=${WITH_ENGINE:-1}

rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/stubs"

echo "Compiling stubs…"
find stubs -name '*.java' > "$OUT/stub-sources.txt"
javac -nowarn -d "$OUT/stubs" @"$OUT/stub-sources.txt"

echo "Compiling plugin…"
find src/main/java -name '*.java' > "$OUT/sources.txt"
javac -nowarn -Xlint:all -source 17 -target 17 \
  -cp "$OUT/stubs" -d "$OUT/classes" @"$OUT/sources.txt"

if [ "$WITH_ENGINE" = "1" ]; then
  echo "Building engine…"
  (cd "$ROOT" && npm run build --silent)

  ENGINE="$OUT/classes/engine"
  mkdir -p "$ENGINE"

  # dist/test is not shipped; everything else the CLI can reach is.
  (cd "$ROOT" && tar --exclude='dist/test' -cf - dist web styles blueprints) \
    | tar -xf - -C "$ENGINE"

  # The engine's own package.json. It declares ESM — without it Node reads the
  # .js files as CommonJS and every import fails — and nothing else, because
  # plugin mode has no dependencies to install.
  VERSION=$(node -p "require('$ROOT/package.json').version")
  cat > "$ENGINE/package.json" <<EOF
{
  "name": "mcai-engine",
  "version": "$VERSION",
  "private": true,
  "type": "module"
}
EOF

  # A dependency creeping into the plugin path would turn "drop one jar" into
  # "drop one jar and run npm install", silently, at someone else's install.
  node scripts/check-engine-deps.mjs "$ENGINE" dist/daemon/bridge-main.js
  echo "  engine: $(find "$ENGINE" -type f | wc -l | tr -d ' ') files packed"
fi

echo "Packaging…"
cp -r src/main/resources/* "$OUT/classes/"
jar --create --file "$OUT/mcAI.jar" -C "$OUT/classes" .

SIZE=$(du -h "$OUT/mcAI.jar" | cut -f1)
echo
echo "  build/mcAI.jar  ($SIZE)"
echo "  Copy it into your server's plugins/ folder and start the server."
