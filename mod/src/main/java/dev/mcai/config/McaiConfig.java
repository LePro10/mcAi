package dev.mcai.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import dev.mcai.McaiMod;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Mod configuration, {@code config/mcai.json}. Created with defaults on first start.
 * Engine discovery normally uses {@code ~/.mcai/engine.json}; {@link Engine} overrides it.
 */
public final class McaiConfig {
	/** Optional fixed engine endpoint. port 0 / empty token = discover via engine.json. */
	public static final class Engine {
		public String host = "127.0.0.1";
		public int port = 0;
		public String token = "";
		/** Start the engine if none is running. null = true for singleplayer/LAN, false on dedicated servers. */
		public Boolean autoStart = null;
		/** Command that starts the engine (overrides MCAI_ENGINE and ~/.mcai/engine-path), e.g. "node /path/engine/src/cli.ts serve". */
		public String command = "";
		/** Web viewer URL shown in chat; empty = http://127.0.0.1:<engine port>/ on singleplayer, hidden on dedicated servers. */
		public String viewerUrl = "";
	}

	public Engine engine = new Engine();
	public boolean autoConnect = true;
	/** Default blocks per tick for set_blocks when the engine does not specify one. */
	public int maxPerTick = 20_000;
	/** Wall-clock budget per server tick for all mcAI world work (ms). */
	public double tickBudgetMs = 15.0;
	/** Mirrors the engine option: allow `time` / `weather` commands from the engine. */
	public boolean allowTimeWeather = false;
	/** Permission level needed for AI builds and /mcai (0–4; the singleplayer owner is always allowed). */
	public int buildPermissionLevel = 2;
	/** Minimum seconds between two build requests of one player. */
	public int buildCooldownSeconds = 10;
	/** Extra command prefixes the engine may run (same meaning as the engine's commandAllowlist). */
	public List<String> commandAllowlist = new ArrayList<>();

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().serializeNulls().create();

	public static McaiConfig load(Path file) {
		McaiConfig cfg = new McaiConfig();
		try {
			if (Files.isRegularFile(file)) {
				McaiConfig read = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), McaiConfig.class);
				if (read != null) {
					cfg = read;
				}
			} else {
				Files.createDirectories(file.getParent());
				Files.writeString(file, GSON.toJson(cfg), StandardCharsets.UTF_8);
			}
		} catch (IOException | RuntimeException e) {
			McaiMod.LOG.warn("mcai: could not read {} ({}), using defaults", file, e.getMessage());
		}
		if (cfg.engine == null) {
			cfg.engine = new Engine();
		}
		if (cfg.commandAllowlist == null) {
			cfg.commandAllowlist = new ArrayList<>();
		}
		cfg.maxPerTick = Math.max(1, cfg.maxPerTick);
		cfg.buildPermissionLevel = Math.clamp(cfg.buildPermissionLevel, 0, 4);
		cfg.buildCooldownSeconds = Math.max(0, cfg.buildCooldownSeconds);
		if (cfg.engine.command == null) {
			cfg.engine.command = "";
		}
		if (cfg.engine.viewerUrl == null) {
			cfg.engine.viewerUrl = "";
		}
		cfg.tickBudgetMs = Math.clamp(cfg.tickBudgetMs, 1.0, 45.0);
		return cfg;
	}
}
