package dev.mcai.engine;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcai.McaiMod;
import dev.mcai.config.EngineEndpoint;
import dev.mcai.config.McaiConfig;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Auto-starts the engine (ARCHITECTURE §5 "Engine discovery & auto-start"). Command resolution:
 * config {@code engine.command} → env {@code MCAI_ENGINE} (engine directory or command) →
 * {@code ~/.mcai/engine-path} (first line = engine directory; runs {@code node <dir>/src/cli.ts serve}).
 * Problems (no node, too old, not set up, crashed) are kept as a translatable {@link Problem} that the
 * UI shows with fix instructions. A process we started is stopped again on game exit.
 */
public final class EngineLauncher {
	private static Process process;
	private static boolean stopping;
	private static Problem problem;
	private static Problem warning;
	private static Path logFile;

	private EngineLauncher() {
	}

	/** Blocking problem (engine cannot run), or null. */
	public static synchronized Problem problem() {
		return problem;
	}

	/** Non-blocking warning (e.g. claude CLI missing), or null. */
	public static synchronized Problem warning() {
		return warning;
	}

	public static synchronized boolean ownsRunningEngine() {
		return process != null && process.isAlive();
	}

	/** Start the engine if configured to and none is running. Never throws. */
	public static synchronized void ensureRunning(McaiConfig cfg, boolean integrated, Path gameDir) {
		boolean auto = cfg.engine.autoStart != null ? cfg.engine.autoStart : integrated;
		if (!auto || cfg.engine.port > 0) {
			problem = null;
			return;
		}
		if (ownsRunningEngine() || externalEngineAlive()) {
			problem = null;
			return;
		}
		try {
			problem = null;
			List<String> cmd = resolveCommand(cfg);
			if (cmd == null) {
				return; // problem set
			}
			checkClaude();
			start(cmd, gameDir);
		} catch (Exception e) {
			problem = Problem.of("mcai.engine.start_failed", "Could not start the engine: %s", String.valueOf(e.getMessage()));
			McaiMod.LOG.warn("mcai: engine auto-start failed", e);
		}
	}

	/** engine.json present and its pid alive → someone else runs an engine. */
	private static boolean externalEngineAlive() {
		Path file = EngineEndpoint.mcaiHome().resolve("engine.json");
		try {
			if (!Files.isRegularFile(file)) {
				return false;
			}
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			return o.has("pid") && ProcessHandle.of(o.get("pid").getAsLong()).map(ProcessHandle::isAlive).orElse(false);
		} catch (Exception e) {
			return false;
		}
	}

	private static List<String> resolveCommand(McaiConfig cfg) throws IOException {
		if (!cfg.engine.command.isBlank()) {
			return withNode(tokenize(cfg.engine.command));
		}
		String env = System.getenv("MCAI_ENGINE");
		if (env != null && !env.isBlank()) {
			Path p = Path.of(env.trim());
			return Files.isDirectory(p) ? nodeCommand(engineDir(p, "MCAI_ENGINE")) : withNode(tokenize(env));
		}
		Path pathFile = EngineEndpoint.mcaiHome().resolve("engine-path");
		if (Files.isRegularFile(pathFile)) {
			// line 1 = engine directory, line 2 (optional) = absolute path of node (launchers do not see the shell PATH)
			List<String> lines = Files.readAllLines(pathFile, StandardCharsets.UTF_8).stream().map(String::trim).filter(l -> !l.isEmpty()).toList();
			List<String> cmd = engineDir(Path.of(lines.isEmpty() ? "" : lines.getFirst()), pathFile.toString());
			if (cmd != null && lines.size() > 1 && Files.isExecutable(Path.of(lines.get(1)))) {
				cmd.set(0, lines.get(1));
			}
			return nodeCommand(cmd);
		}
		problem = Problem.of("mcai.engine.not_setup",
				"The mcAI engine is not set up. In the mcAI folder run: ./mcai setup — or set engine.command in config/mcai.json.");
		return null;
	}

	private static List<String> engineDir(Path dir, String source) {
		Path cli = dir.resolve("src").resolve("cli.ts");
		if (!Files.isRegularFile(cli)) {
			problem = Problem.of("mcai.engine.bad_path", "%s points to %s, but %s does not exist. Run ./mcai setup in the mcAI folder again.",
					source, dir.toString(), cli.toString());
			return null;
		}
		return new ArrayList<>(List.of("node", cli.toString(), "serve"));
	}

	private static List<String> nodeCommand(List<String> cmd) {
		return cmd == null ? null : withNode(cmd);
	}

	/** Replace a leading bare "node" by a located, version-checked node binary. */
	private static List<String> withNode(List<String> cmd) {
		if (cmd.isEmpty()) {
			problem = Problem.of("mcai.engine.not_setup",
					"The mcAI engine is not set up. In the mcAI folder run: ./mcai setup — or set engine.command in config/mcai.json.");
			return null;
		}
		String exe = cmd.getFirst();
		if (!exe.equals("node") && !exe.endsWith("/node") && !exe.endsWith("\\node.exe") && !exe.endsWith("\\node")) {
			return cmd;
		}
		Optional<Path> node = exe.equals("node") ? Toolchain.find("node") : Optional.of(Path.of(exe));
		if (node.isEmpty()) {
			problem = Problem.of("mcai.engine.no_node", "Node.js was not found. Install Node.js 22.18 or newer from https://nodejs.org and restart Minecraft.");
			return null;
		}
		String version = Toolchain.version(node.get());
		if (version == null) {
			problem = Problem.of("mcai.engine.node_broken", "%s could not be run. Reinstall Node.js 22.18+ from https://nodejs.org.", node.get().toString());
			return null;
		}
		if (Toolchain.compare(Toolchain.versionOf(version), Toolchain.MIN_NODE) < 0) {
			problem = Problem.of("mcai.engine.node_old", "Node.js %s is too old — the engine needs 22.18 or newer (https://nodejs.org).", version);
			return null;
		}
		cmd.set(0, node.get().toString());
		return cmd;
	}

	private static void checkClaude() {
		warning = Toolchain.find("claude").isPresent() || claudeFromEngineConfig() ? null
				: Problem.of("mcai.engine.no_claude", "Claude Code (claude) was not found — AI builds will fail. Install it: npm install -g @anthropic-ai/claude-code");
	}

	/** The engine's ~/.mcai/config.json may name claude explicitly (claudePath). */
	private static boolean claudeFromEngineConfig() {
		try {
			Path f = EngineEndpoint.mcaiHome().resolve("config.json");
			if (!Files.isRegularFile(f)) {
				return false;
			}
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			return o.has("claudePath") && Files.isExecutable(Path.of(o.get("claudePath").getAsString()));
		} catch (Exception e) {
			return false;
		}
	}

	private static void start(List<String> cmd, Path gameDir) throws IOException {
		Path logs = gameDir.resolve("logs");
		Files.createDirectories(logs);
		logFile = logs.resolve("mcai-engine.log");
		ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true)
				.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile.toFile()));
		Path script = cmd.size() > 1 ? Path.of(cmd.get(1)) : null;
		if (script != null && script.isAbsolute() && script.getParent() != null && Files.isDirectory(script.getParent())) {
			// engine dir = parent of src/ for "node <dir>/src/cli.ts", else the script's directory
			Path parent = script.getParent();
			pb.directory((parent.getFileName() != null && parent.getFileName().toString().equals("src") ? parent.getParent() : parent).toFile());
		}
		List<Path> tools = new ArrayList<>();
		Path exe = Path.of(cmd.getFirst());
		if (exe.getParent() != null) {
			tools.add(exe.getParent());
		}
		Toolchain.find("claude").ifPresent(c -> tools.add(c.getParent()));
		pb.environment().put("PATH", Toolchain.childPath(tools));
		stopping = false;
		Process p = pb.start();
		process = p;
		McaiMod.LOG.info("mcai: started engine (pid {}): {} — log: {}", p.pid(), String.join(" ", cmd), logFile);
		p.onExit().thenAccept(done -> {
			synchronized (EngineLauncher.class) {
				if (!stopping && process == done) {
					problem = Problem.of("mcai.engine.exited", "The engine stopped unexpectedly (exit code %s) — see %s",
							String.valueOf(done.exitValue()), logFile.toString());
					McaiMod.LOG.warn("mcai: engine exited with code {} (see {})", done.exitValue(), logFile);
				}
			}
		});
	}

	/** Stop the engine if this game started it (game exit). */
	public static synchronized void stopIfOwned() {
		Process p = process;
		process = null;
		if (p == null || !p.isAlive()) {
			return;
		}
		stopping = true;
		McaiMod.LOG.info("mcai: stopping the engine we started (pid {})", p.pid());
		p.descendants().forEach(ProcessHandle::destroy);
		p.destroy();
		try {
			if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
				p.descendants().forEach(ProcessHandle::destroyForcibly);
				p.destroyForcibly();
			}
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}

	/** Split a command line on whitespace, honouring "double" and 'single' quotes. */
	static List<String> tokenize(String line) {
		List<String> out = new ArrayList<>();
		StringBuilder cur = new StringBuilder();
		char quote = 0;
		boolean has = false;
		for (char c : line.trim().toCharArray()) {
			if (quote != 0) {
				if (c == quote) {
					quote = 0;
				} else {
					cur.append(c);
				}
			} else if (c == '"' || c == '\'') {
				quote = c;
				has = true;
			} else if (Character.isWhitespace(c)) {
				if (has || !cur.isEmpty()) {
					out.add(cur.toString());
					cur.setLength(0);
					has = false;
				}
			} else {
				cur.append(c);
			}
		}
		if (has || !cur.isEmpty()) {
			out.add(cur.toString());
		}
		return out;
	}

	static {
		Runtime.getRuntime().addShutdownHook(new Thread(EngineLauncher::stopIfOwned, "mcai-engine-stop"));
	}
}
