package dev.mcai.plugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.logging.Level;

/**
 * Starts and supervises the mcAI engine.
 *
 * The engine is the Node process that holds the blueprint compiler. Running it
 * here means the person installing mcAI never opens a terminal: the plugin
 * starts it, restarts it if it dies, and reports why if it cannot.
 *
 * Node itself is the one thing the plugin cannot provide. When it is missing,
 * say so once, clearly, with the address to get it — rather than failing on
 * every build with something cryptic.
 */
final class EngineProcess {

  private static final int MAX_RESTARTS = 5;
  private static final long RESTART_WINDOW_MS = 60_000;

  private final McAiPlugin plugin;
  private final int bridgePort;
  private final int dashboardPort;
  private final String token;

  private Process process;
  private Thread reader;
  private volatile boolean stopping;
  private final Deque<String> output = new ArrayDeque<>();
  private final List<Long> restarts = new ArrayList<>();
  private volatile String lastError;

  EngineProcess(McAiPlugin plugin, int bridgePort, int dashboardPort, String token) {
    this.plugin = plugin;
    this.bridgePort = bridgePort;
    this.dashboardPort = dashboardPort;
    this.token = token;
  }

  synchronized void start() {
    stopping = false;

    File dir = plugin.engineDirectory();
    File entry = new File(dir, "dist/cli/main.js");
    if (!entry.isFile()) {
      lastError = "The engine is not installed in " + dir.getAbsolutePath();
      plugin.getLogger().warning(lastError);
      plugin.getLogger().warning("Put the mcAI engine there, or set engine-path in config.yml.");
      plugin.getLogger().warning("Until then, /mcai build still works for the built-in structures"
          + " only if the engine is reachable — see the plugin README.");
      return;
    }

    String node = findNode();
    if (node == null) {
      lastError = "Node.js was not found on this machine.";
      plugin.getLogger().warning("mcAI needs Node.js 20 or newer: https://nodejs.org");
      plugin.getLogger().warning("Install it, then run /mcai reload or restart the server.");
      return;
    }

    try {
      ProcessBuilder pb = new ProcessBuilder(
          node, entry.getAbsolutePath(), "serve", "--plugin",
          "--port", String.valueOf(dashboardPort));
      pb.directory(dir);
      pb.redirectErrorStream(true);
      pb.environment().put("MCAI_BRIDGE_URL", "http://127.0.0.1:" + bridgePort);
      pb.environment().put("MCAI_BRIDGE_TOKEN", token);
      pb.environment().put("MCAI_HTTP_PORT", String.valueOf(dashboardPort));
      // Keep the engine's saved provider next to the plugin, so a server move
      // takes the configuration with it.
      pb.environment().put("MCAI_HOME", new File(plugin.getDataFolder(), "config").getAbsolutePath());

      process = pb.start();
      lastError = null;
      plugin.getLogger().info("Engine started (pid " + process.pid() + ").");
      startReader();
    } catch (Exception e) {
      lastError = e.getMessage();
      plugin.getLogger().log(Level.WARNING, "Could not start the engine", e);
    }
  }

  private void startReader() {
    reader = new Thread(() -> {
      try (BufferedReader in = new BufferedReader(
          new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
        String line;
        while ((line = in.readLine()) != null) {
          record(line);
        }
      } catch (Exception ignored) {
        // The stream closes when the process exits; that is handled below.
      }
      if (!stopping) onExit();
    }, "mcAI-engine-output");
    reader.setDaemon(true);
    reader.start();
  }

  private void onExit() {
    int code = process == null ? -1 : process.exitValue();
    plugin.getLogger().warning("The mcAI engine stopped (exit " + code + ").");
    for (String line : recentOutput()) plugin.getLogger().warning("  " + line);

    // Restart, but not forever: a config error would otherwise loop until
    // someone notices, filling the log and hiding the real cause.
    long now = System.currentTimeMillis();
    restarts.removeIf(t -> now - t > RESTART_WINDOW_MS);
    if (restarts.size() >= MAX_RESTARTS) {
      lastError = "Stopped restarting after " + MAX_RESTARTS + " failures in a minute.";
      plugin.getLogger().severe(lastError + " Fix the cause, then /mcai reload.");
      return;
    }
    restarts.add(now);
    try { Thread.sleep(2000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
    if (!stopping) start();
  }

  synchronized void stop() {
    stopping = true;
    if (process == null) return;
    process.destroy();
    try {
      if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      process.destroyForcibly();
    }
    process = null;
  }

  boolean isRunning() {
    return process != null && process.isAlive();
  }

  String status() {
    if (isRunning()) return "running (pid " + process.pid() + ")";
    return lastError != null ? "stopped — " + lastError : "stopped";
  }

  /** The last few lines the engine printed, for diagnosing a failed start. */
  synchronized List<String> recentOutput() {
    return new ArrayList<>(output);
  }

  private synchronized void record(String line) {
    output.addLast(line);
    while (output.size() > 12) output.removeFirst();
  }

  /**
   * Find Node.
   *
   * `node` on PATH covers most installs. The explicit paths catch the common
   * case of a server started by an init system with a minimal PATH, where a
   * perfectly good Node is present but invisible.
   */
  private String findNode() {
    String configured = plugin.getConfig().getString("node-path", "");
    if (configured != null && !configured.isEmpty() && new File(configured).canExecute()) return configured;

    List<String> candidates = List.of(
        "node",
        "/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node",
        "/snap/bin/node", System.getProperty("user.home") + "/.nvm/versions/node/current/bin/node");

    for (String candidate : candidates) {
      try {
        Process p = new ProcessBuilder(candidate, "--version").redirectErrorStream(true).start();
        if (p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS) && p.exitValue() == 0) return candidate;
      } catch (Exception ignored) {
        // Not here; try the next one.
      }
    }
    return null;
  }
}
