package dev.mcai.plugin;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.entity.Player;

/**
 * The bridge the engine talks to.
 *
 * Uses the HTTP server built into the JDK, so the plugin has no dependencies
 * and the jar stays small enough to read.
 *
 * Everything that touches the world must run on the main server thread —
 * Bukkit is not thread safe, and reading a block from an HTTP worker is a
 * reliable way to corrupt a world. So each handler builds a Callable and hands
 * it to the scheduler, then waits for the result. The engine is on loopback
 * and batches its work, so the waiting is measured in single-digit ticks.
 */
final class BridgeServer {

  /** Refuse absurd requests rather than freezing the server for a minute. */
  private static final int MAX_COMMANDS = 20_000;
  private static final long MAX_REGION_VOLUME = 2_000_000L;
  private static final long MAX_HEIGHTMAP = 250_000L;
  private static final long SYNC_TIMEOUT_SECONDS = 60;

  private final McAiPlugin plugin;
  private final int port;
  private final String token;
  private HttpServer server;

  BridgeServer(McAiPlugin plugin, int port, String token) throws IOException {
    this.plugin = plugin;
    this.port = port;
    this.token = token;
  }

  void start() throws IOException {
    // Loopback only. This interface can rewrite the world.
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.setExecutor(Executors.newFixedThreadPool(2));

    server.createContext("/info", this::handleInfo);
    server.createContext("/exec", this::handleExec);
    server.createContext("/heightmap", this::handleHeightmap);
    server.createContext("/region", this::handleRegion);
    server.createContext("/player/", this::handlePlayer);
    server.createContext("/say", this::handleSay);
    server.start();
  }

  void stop() {
    if (server != null) server.stop(0);
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  private void handleInfo(HttpExchange ex) throws IOException {
    if (!authorised(ex)) return;
    World w = plugin.world();
    StringBuilder players = new StringBuilder("[");
    for (Player p : Bukkit.getOnlinePlayers()) {
      if (players.length() > 1) players.append(',');
      players.append(Json.string(p.getName()));
    }
    players.append(']');
    respond(ex, 200, "{\"ok\":true,\"plugin\":" + Json.string(Version.PLUGIN)
        + ",\"minecraft\":" + Json.string(Bukkit.getBukkitVersion())
        + ",\"world\":" + Json.string(w == null ? "" : w.getName())
        + ",\"players\":" + players + "}");
  }

  private void handleExec(HttpExchange ex) throws IOException {
    if (!authorised(ex)) return;
    String body = read(ex);
    final List<String> commands = Json.stringArray(body, "commands");
    if (commands == null) { respond(ex, 400, "{\"error\":\"commands must be an array\"}"); return; }
    if (commands.size() > MAX_COMMANDS) {
      respond(ex, 413, "{\"error\":\"batch of " + commands.size() + " exceeds " + MAX_COMMANDS + "\"}");
      return;
    }

    // One scheduler round trip for the whole batch: the server executes them
    // back to back inside a single tick's worth of work rather than paying a
    // tick of latency per command.
    List<String> messages = sync(ex, () -> {
      List<String> out = new ArrayList<>(commands.size());
      for (String command : commands) {
        String clean = command.startsWith("/") ? command.substring(1) : command;
        out.add(CommandRunner.run(clean));
      }
      return out;
    });
    if (messages == null) return;

    StringBuilder json = new StringBuilder("{\"results\":[");
    for (int i = 0; i < messages.size(); i++) {
      if (i > 0) json.append(',');
      String message = messages.get(i);
      json.append("{\"ok\":true,\"affected\":0,\"message\":").append(Json.string(message)).append('}');
    }
    json.append("]}");
    respond(ex, 200, json.toString());
  }

  private void handleHeightmap(HttpExchange ex) throws IOException {
    if (!authorised(ex)) return;
    Map<String, String> q = query(ex);
    final int x1 = intOf(q, "x1"), z1 = intOf(q, "z1"), x2 = intOf(q, "x2"), z2 = intOf(q, "z2");
    long area = (long) (x2 - x1 + 1) * (z2 - z1 + 1);
    if (area <= 0 || area > MAX_HEIGHTMAP) {
      respond(ex, 400, "{\"error\":\"area of " + area + " is out of range\"}");
      return;
    }

    int[] heights = sync(ex, () -> {
      World w = plugin.world();
      int[] out = new int[(int) area];
      int i = 0;
      for (int z = z1; z <= z2; z++)
        for (int x = x1; x <= x2; x++) out[i++] = w.getHighestBlockYAt(x, z);
      return out;
    });
    if (heights == null) return;

    int min = Integer.MAX_VALUE, max = Integer.MIN_VALUE;
    long total = 0;
    StringBuilder json = new StringBuilder("{\"heights\":[");
    for (int i = 0; i < heights.length; i++) {
      if (i > 0) json.append(',');
      json.append(heights[i]);
      if (heights[i] < min) min = heights[i];
      if (heights[i] > max) max = heights[i];
      total += heights[i];
    }
    json.append("],\"min\":").append(min).append(",\"max\":").append(max)
        .append(",\"avg\":").append(Math.round((double) total / heights.length)).append('}');
    respond(ex, 200, json.toString());
  }

  private void handleRegion(HttpExchange ex) throws IOException {
    if (!authorised(ex)) return;
    String body = read(ex);
    final int[] min = Json.intArray(body, "min");
    final int[] max = Json.intArray(body, "max");
    if (min == null || max == null || min.length != 3 || max.length != 3) {
      respond(ex, 400, "{\"error\":\"min and max must each be [x,y,z]\"}");
      return;
    }
    long volume = (long) (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
    if (volume <= 0 || volume > MAX_REGION_VOLUME) {
      respond(ex, 400, "{\"error\":\"region of " + volume + " blocks is out of range\"}");
      return;
    }

    String json = sync(ex, () -> {
      World w = plugin.world();
      List<String> palette = new ArrayList<>();
      Map<String, Integer> index = new HashMap<>();
      StringBuilder data = new StringBuilder();
      for (int y = min[1]; y <= max[1]; y++)
        for (int z = min[2]; z <= max[2]; z++)
          for (int x = min[0]; x <= max[0]; x++) {
            String spec = Blocks.spec(w.getBlockAt(x, y, z));
            Integer i = index.get(spec);
            if (i == null) { i = palette.size(); palette.add(spec); index.put(spec, i); }
            if (data.length() > 0) data.append(',');
            data.append(i.intValue());
          }
      StringBuilder pal = new StringBuilder("[");
      for (int i = 0; i < palette.size(); i++) {
        if (i > 0) pal.append(',');
        pal.append(Json.string(palette.get(i)));
      }
      pal.append(']');
      return "{\"palette\":" + pal + ",\"data\":[" + data + "]}";
    });
    if (json == null) return;
    respond(ex, 200, json);
  }

  private void handlePlayer(HttpExchange ex) throws IOException {
    if (!authorised(ex)) return;
    String path = ex.getRequestURI().getPath();
    final String name = java.net.URLDecoder.decode(
        path.substring(path.lastIndexOf('/') + 1), StandardCharsets.UTF_8);

    String json = sync(ex, () -> {
      Player p = Bukkit.getPlayerExact(name);
      if (p == null) return "{\"found\":false}";
      return "{\"found\":true,\"name\":" + Json.string(p.getName())
          + ",\"position\":[" + p.getLocation().getBlockX() + ","
          + p.getLocation().getBlockY() + "," + p.getLocation().getBlockZ() + "]"
          + ",\"yaw\":" + p.getLocation().getYaw()
          + ",\"world\":" + Json.string(p.getLocation().getWorld().getName()) + "}";
    });
    if (json == null) return;
    respond(ex, 200, json);
  }

  private void handleSay(HttpExchange ex) throws IOException {
    if (!authorised(ex)) return;
    String body = read(ex);
    final String message = Json.field(body, "message");
    final String player = Json.field(body, "player");
    if (message == null) { respond(ex, 400, "{\"error\":\"message is required\"}"); return; }

    Bukkit.getScheduler().runTask(plugin, () -> {
      String text = Chat.info(message);
      if (player != null) {
        Player p = Bukkit.getPlayerExact(player);
        if (p != null) { p.sendMessage(text); return; }
      }
      Bukkit.broadcastMessage(text);
    });
    respond(ex, 200, "{\"ok\":true}");
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  /**
   * Run a task on the main thread and wait for it.
   *
   * Returns null after responding with an error, so callers can simply bail.
   */
  private <T> T sync(HttpExchange ex, Callable<T> task) throws IOException {
    try {
      Future<T> future = Bukkit.getScheduler().callSyncMethod(plugin, task);
      return future.get(SYNC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    } catch (Exception e) {
      Throwable cause = e.getCause() != null ? e.getCause() : e;
      respond(ex, 500, "{\"error\":" + Json.string(String.valueOf(cause.getMessage())) + "}");
      return null;
    }
  }

  private boolean authorised(HttpExchange ex) throws IOException {
    String provided = ex.getRequestHeaders().getFirst("x-mcai-token");
    if (token.equals(provided)) return true;
    respond(ex, 401, "{\"error\":\"bad token\"}");
    return false;
  }

  private static String read(HttpExchange ex) throws IOException {
    return new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
  }

  private static void respond(HttpExchange ex, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = ex.getResponseBody()) { out.write(bytes); }
  }

  private static Map<String, String> query(HttpExchange ex) {
    Map<String, String> out = new HashMap<>();
    String raw = ex.getRequestURI().getRawQuery();
    if (raw == null) return out;
    for (String pair : raw.split("&")) {
      int eq = pair.indexOf('=');
      if (eq > 0) out.put(pair.substring(0, eq), pair.substring(eq + 1));
    }
    return out;
  }

  private static int intOf(Map<String, String> q, String key) {
    try { return Integer.parseInt(q.getOrDefault(key, "0")); }
    catch (NumberFormatException e) { return 0; }
  }
}
