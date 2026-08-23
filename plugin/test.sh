#!/usr/bin/env bash
# Run the plugin's Java tests.
#
# Only the parts that can be tested without a server: the JSON codec, which is
# where a hand-rolled parser would quietly corrupt a player's prompt or drop a
# command out of a batch. The world-facing code is covered from the TypeScript
# side, against the simulated plugin server in src/sim/plugin-server.ts.
set -euo pipefail
cd "$(dirname "$0")"

./build.sh > /dev/null

OUT=build/test
rm -rf "$OUT" && mkdir -p "$OUT"

find test -name '*.java' > "$OUT/sources.txt"
javac -nowarn -cp "build/classes" -d "$OUT" @"$OUT/sources.txt"

java -cp "build/classes:$OUT" dev.mcai.plugin.JsonTest
