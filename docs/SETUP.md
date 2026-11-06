# mcAI — Setup & Start

*Deutsch zuerst — [English below](#english).*

---

## Deutsch

### Voraussetzungen

| | |
|---|---|
| **Minecraft Java Edition** | offizieller Launcher (<https://www.minecraft.net/download>), einmal gestartet und eingeloggt |
| **Node.js ≥ 22.18** | <https://nodejs.org> (macOS: `brew install node`) |
| **Claude Code** | `npm install -g @anthropic-ai/claude-code`, danach einmal `claude` starten und `/login` |
| **Java 25** | nur für den Server und zum Bauen des Mods; der Launcher bringt sein eigenes Java mit. Gefunden werden `JAVA_HOME`, `~/.mcai-tools/jdk-*`, `/usr/libexec/java_home` und – nachdem 26.3 einmal lief – das Java des Launchers |

### Einrichten (ein Befehl)

```sh
./mcai setup --dry-run   # zeigt nur, was passieren würde
./mcai setup             # erledigt alles
```

`setup` installiert die Engine-Abhängigkeiten (`npm ci`), baut den Mod falls nötig, richtet mcAI im
Minecraft-Launcher ein und prüft am Ende alles (`mcai doctor`). **Der Launcher muss dafür geschlossen
sein** (Cmd+Q) — er überschreibt `launcher_profiles.json` beim Beenden. Mit `--wait` wartet das Skript,
bis du ihn geschlossen hast.

Was im Launcher passiert:

* neue Version **`fabric-loader-0.20.1-26.3`** (Fabric-Profil von meta.fabricmc.net; Bibliotheken
  sha1-geprüft vorab geladen),
* neues Profil **„mcAI · Fabric 26.3“** mit eigenem Spielordner
  `~/Library/Application Support/minecraft/profiles/mcai` — Welten, Mods und Einstellungen sind von
  deinen anderen Profilen getrennt,
* `launcher_profiles.json` wird vorher gesichert (`~/.mcai/backups/`, die letzten 10) und nur
  ergänzt, nie überschrieben,
* Mods von Modrinth — jede Datei wird gegen den sha512 aus der Modrinth-API geprüft, und es werden nur
  Versionen genommen, die ausdrücklich Minecraft 26.3 + Fabric angeben (Release vor Beta, nie Alpha):

| Mod | Wozu |
|---|---|
| Fabric API | Pflicht für mcAI |
| Sodium | neuer Renderer — der mit Abstand größte FPS-Gewinn auf Intel-Grafik |
| Lithium | schnellere Spiellogik (auch im Einzelspieler-Server) |
| FerriteCore | weniger Arbeitsspeicher |
| ImmediatelyFast | schnelleres Zeichnen von GUI, Text, Entities |
| Entity Culling | verdeckte (Block-)Entities werden nicht gerendert |
| Dynamic FPS | drosselt FPS im Hintergrund/minimiert — spart Akku und Hitze |
| mcAI | unser Mod (`mod/build/libs/mcai-2.0.0.jar`) |

Erneutes Ausführen aktualisiert idempotent: alte Versionen werden entfernt, eigene zusätzliche Mods
bleiben unberührt (ein *anderes* Exemplar eines von uns verwalteten Mods wird nach `mods.disabled/`
verschoben, damit es nicht kollidiert).

### Spielen (Einzelspieler)

```sh
./mcai play
```

Startet die Engine im Hintergrund, aktualisiert das mcAI-Profil falls der Mod neu gebaut wurde und
öffnet den Launcher. Dort **„mcAI · Fabric 26.3“** wählen → **Spielen**. Startest du Minecraft direkt
über den Launcher, startet der Mod die Engine selbst (über `~/.mcai/engine-path`).

Im Spiel: Architektenstab (`/mcai help`), Boden rechtsklicken, Bauwunsch beschreiben. Den Fortschritt
siehst du live im Web-Viewer (`./mcai viewer`).

### Eigener Server (Mehrspieler)

```sh
./mcai server start --accept-eula     # erstes Mal: du akzeptierst die Minecraft-EULA
./mcai server start [--offline] [--port 25565]
./mcai server status | logs [-f] | console | cmd "op DeinName" | stop | restart
```

* Ordner `server/` (nicht in Git; anderer Ort: `MCAI_SERVER_DIR`). Vanilla-`server.jar` sha1-geprüft,
  Fabric-Server-Launcher, Mods: Fabric API, Lithium, FerriteCore, mcAI. Die Engine startet mit.
* **EULA:** Ein Minecraft-Server erfordert, dass *du* die EULA akzeptierst (<https://aka.ms/MinecraftEULA>).
  mcAI tut das nie automatisch — nur mit `--accept-eula` oder `MCAI_ACCEPT_EULA=1`.
* `server.properties` beim ersten Start: `online-mode=true` (Konten werden geprüft), Sichtweite 10,
  Simulation 8, `pause-when-empty-seconds=0` (KI-Bauten laufen weiter, wenn du offline gehst).
  `--offline` nur für LAN/vertrauenswürdige Netze: dann kann jeder mit beliebigem Namen beitreten.
  Danach ändert das Skript nur noch, was du explizit angibst.
* Heap: `MCAI_SERVER_XMX` (Standard 4G). JVM: die bekannten G1-Flags von Aikar (ohne `AlwaysPreTouch`,
  das auf einem Laptop nur RAM blockiert und den Start bremst).
* **Wichtig:** Einzelspieler und Server teilen sich eine Engine; die jeweils neueste Mod-Verbindung
  ersetzt die ältere. Deshalb verweigert `./mcai play`, solange der Server läuft (`--force` erzwingt es).

### Engine & Viewer ohne Minecraft

```sh
./mcai start --sim          # Simulationswelt + Viewer im Browser
./mcai build "eine kleine Holzhütte mit Garten"   # kompletter KI-Bau headless, Bilder in mcai-out/
./mcai status               # Engine, Minecraft-Verbindung, Jobs, Server, Client
./mcai logs [engine|server|game] [-f]
./mcai stop [--all]         # --all stoppt auch den Server
./mcai update               # Mod neu bauen + überall neu installieren
```

Logs: `~/.mcai/logs/engine.log`, Server: `server/logs/latest.log`, Spiel:
`…/minecraft/profiles/mcai/logs/latest.log`.

### Warum diese Einstellungen (Intel UHD 620, 8 Threads, 32 GB)

**JVM des Spiels:** `-Xms2G -Xmx6G -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20
-XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M`

* Das sind exakt Mojangs eigene Launcher-Standardflags (G1, auf kurze Pausen getrimmt, 32-MB-Regionen
  damit große Chunk-Arrays keine „humongous“ Allokationen werden) — nur der Heap ist größer.
* 6 GB reichen für Sichtweite 10 + Mods + KI-Bauten mit Millionen Blöcken locker; mehr bringt nichts
  (größerer Heap = längere GC-Zyklen), und die integrierte GPU nutzt ebenfalls den Arbeitsspeicher.
  Bei < 24 GB RAM wählt das Skript 4G, bei < 12 GB 3G (`--xmx` überschreibt).
* Kein Flag-„Cargo-Cult“: keine entfernten Flags (z. B. CMS, `AggressiveOpts`), nichts, was Java 25
  ohnehin standardmäßig tut. Änderst du die JVM-Argumente im Launcher, lässt `setup` sie künftig in Ruhe.

**options.txt** (nur wenn noch keine existiert): Sichtweite 10, Simulationsdistanz 8, 60 FPS + VSync
(gleichmäßig statt heiß), Wolken „schnell“, weiche Beleuchtung an, Entity-Distanz 100 %, Biom-Übergang
3×3 (deutlich günstiger beim Chunk-Bau, kaum sichtbar), Wetterradius 5, „verbesserte Transparenz“ aus
(zu teuer für eine iGPU), GUI-Größe automatisch, Erzähler aus, Sprache aus dem System (Deutsch → `de_de`).
Sodium bringt bereits sehr gute Standardwerte mit; deshalb schreiben wir keine Sodium-Konfiguration.

**Shader:** standardmäßig aus — die UHD 620 ist dafür zu schwach. `./mcai setup --shaders` installiert
Iris + das sehr leichte „MakeUp – Ultra Fast“; `--no-shaders` entfernt es wieder. Umschalten im Spiel: `K`.

### Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Launcher is running“ | Launcher mit Cmd+Q beenden (nicht nur das Fenster schließen), dann erneut ausführen — oder `--wait` |
| Profil fehlt im Launcher | Launcher lief beim Setup → `./mcai setup` mit geschlossenem Launcher wiederholen |
| Engine offline / Stab reagiert nicht | `./mcai status`, `./mcai logs engine`, `./mcai doctor`; Neustart: `./mcai stop && ./mcai play` |
| „claude not found“ / KI baut nicht | `npm install -g @anthropic-ai/claude-code`, dann `claude` → `/login`. Das Spiel sieht deinen Shell-`PATH` nicht; `setup` trägt deshalb den absoluten Pfad als `claudePath` in `~/.mcai/config.json` ein |
| Gefiltertes Netz (Mojang gesperrt) | Mods kommen von Modrinth, Fabric von maven.fabricmc.net. Für Minecraft selbst: `./mcai setup --seed-cache` kopiert die verifizierten 26.3-Dateien aus `~/.mcai-tools/mc` in den Launcher (er prüft sie erneut), `--java /pfad/zu/jdk-25` nutzt ein lokales Java statt des Launcher-Downloads. Die Anmeldung (Microsoft) braucht trotzdem Netz |
| Server startet nicht: Port belegt | `./mcai server start --port 25566` |
| Ruckeln / niedrige FPS | Laptop ans Netzteil; Sichtweite 8; Wolken aus; Partikel „verringert“; keine Shader; F3 zeigt FPS. Bei großen KI-Bauten entstehen viele Chunk-Updates gleichzeitig — kurz warten, Sodium baut sie im Hintergrund |
| Spiel startet nicht nach Update | `./mcai logs game`; ein Mod-Konflikt landet in `mods.disabled/`; notfalls `./mcai uninstall && ./mcai setup` |

### Deinstallieren

```sh
./mcai uninstall --dry-run
./mcai uninstall                 # Profil, Fabric-Version und von mcAI verwaltete Mods entfernen
./mcai uninstall --restore-backup  # stattdessen launcher_profiles.json von vor der ersten Installation
./mcai uninstall --purge         # zusätzlich den Spielordner profiles/mcai löschen (inkl. Welten!)
```

Welten bleiben ohne `--purge` erhalten. `~/.mcai` (Jobs, Strukturen, Logs) und der Ordner `server/`
werden nie automatisch gelöscht.

---

## English

### Requirements

Minecraft Java Edition with the official launcher (started once, logged in) · Node.js ≥ 22.18 ·
Claude Code (`npm install -g @anthropic-ai/claude-code`, run `claude` once, `/login`) · Java 25 only for
the server and for building the mod (found via `JAVA_HOME`, `~/.mcai-tools/jdk-*`, `java_home`, or the
launcher's own runtime after 26.3 ran once).

### Setup

```sh
./mcai setup --dry-run
./mcai setup          # engine deps, mod build, launcher install, doctor
```

The launcher must be **closed** (Cmd+Q) — it rewrites `launcher_profiles.json` when it quits (`--wait`
waits for you). The installer adds the version `fabric-loader-0.20.1-26.3`, a profile
**"mcAI · Fabric 26.3"** with its own game directory (`…/minecraft/profiles/mcai`), backs up
`launcher_profiles.json` to `~/.mcai/backups/` and merges into it. Mods (Fabric API, Sodium, Lithium,
FerriteCore, ImmediatelyFast, Entity Culling, Dynamic FPS, mcAI) come from Modrinth, each verified by the
API's sha512, only versions that declare 26.3 + Fabric. Re-runs update idempotently; your own extra mods
are left alone. It also writes `~/.mcai/engine-path` (line 1: engine directory, read by the mod to
auto-start the engine in singleplayer; line 2: absolute node path) and pins `claudePath` in
`~/.mcai/config.json` because games started from the launcher do not inherit your shell `PATH`.

### Play

`./mcai play` starts the engine, refreshes the mcAI profile if the mod jar changed and opens the
launcher: pick **"mcAI · Fabric 26.3"** → **Play**. Started from the launcher directly, the mod starts the
engine itself.

### Server

`./mcai server start --accept-eula` (first time — **you** accept <https://aka.ms/MinecraftEULA>; mcAI never
does) then `./mcai server start [--offline] [--port N]`, `status`, `logs [-f]`, `console`, `cmd "<command>"`,
`stop`, `restart`. Directory `server/` (gitignored, `MCAI_SERVER_DIR` overrides), verified `server.jar`,
Fabric API + Lithium + FerriteCore + mcAI, `online-mode=true` by default (`--offline` for trusted LAN
only), view 10 / simulation 8, `pause-when-empty-seconds=0`. Heap `MCAI_SERVER_XMX` (4G), Aikar's G1 flags.
Singleplayer and a server share one engine — `./mcai play` refuses while the server runs (`--force`).

### Engine & viewer

`./mcai start --sim` (simulation + browser viewer), `./mcai build "<prompt>"` (headless build, PNG
renders), `./mcai status`, `./mcai logs [engine|server|game] [-f]`, `./mcai stop [--all]`, `./mcai update`.

### Performance choices (Intel UHD 620)

Game JVM = Mojang's own launcher defaults (G1, `MaxGCPauseMillis=50`, `G1HeapRegionSize=32M`, new/reserve
20 %) with `-Xms2G -Xmx6G` (4G below 24 GB RAM, 3G below 12 GB; `--xmx` overrides) — more heap only
lengthens GC cycles, and the iGPU shares system RAM. Your own edits to the profile's JVM arguments are
kept on re-runs. `options.txt` (only if absent): render 10, simulation 8, 60 FPS + VSync, fast clouds,
smooth lighting, entity distance 100 %, biome blend 3×3, weather radius 5, improved transparency off,
GUI auto, narrator off, system language. Sodium's defaults are kept. Shaders are off by default;
`--shaders` adds Iris + "MakeUp – Ultra Fast" (`--no-shaders` removes them).

### Troubleshooting

Launcher running → quit it with Cmd+Q and re-run (or `--wait`). Engine offline → `./mcai status`,
`./mcai logs engine`, `./mcai doctor`. Claude not found/not logged in → install Claude Code, run `claude`,
`/login`. Filtered network → `--seed-cache` (copies the verified 26.3 files from `~/.mcai-tools/mc`; the
launcher re-verifies them) and `--java <jdk-25>`; Microsoft login still needs network access. Port busy →
`--port`. Low FPS → plug in the charger, render distance 8, clouds off, no shaders.

### Uninstall

`./mcai uninstall [--dry-run] [--restore-backup] [--purge]` — removes the profile, the Fabric version and
mcAI-managed mods; worlds stay unless `--purge`. `~/.mcai` and `server/` are never deleted automatically.
