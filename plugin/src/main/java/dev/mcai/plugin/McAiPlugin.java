package dev.mcai.plugin;

import java.io.File;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.logging.Level;

import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * mcAI — a natural-language builder, as a server plugin.
 *
 * The point of this class is that installing mcAI becomes: drop the jar in
 * plugins/, start the server. Everything the old setup needed a human for is
 * handled here.
 *
 *   - No RCON. Commands run through the server's own dispatcher, so there is
 *     no port to open, no password to invent and no server.properties to edit.
 *   - No bot account. Player positions come from the server, which also means
 *     the server can stay in online mode.
 *   - No terminal. The engine is started as a child process and supervised;
 *     the API key is entered in game or in the dashboard.
 *
 * The building itself lives in the Node engine, which holds the blueprint
 * compiler. This plugin is the part that has to be Java: it is the only place
 * that can touch the world directly.
 */
public final class McAiPlugin extends JavaPlugin implements CommandExecutor, TabCompleter {

  /** The world edits and reads go to. Configurable; defaults to the first. */
  private String worldName;

  private BridgeServer bridge;
  private EngineProcess engine;
  private String token;

  @Override
  public void onEnable() {
    saveDefaultConfig();

    token = getConfig().getString("token", "");
    if (token == null || token.isEmpty()) {
      // A shared secret between the plugin and the engine, both on loopback.
      // Generated once so nobody has to think about it.
      byte[] bytes = new byte[24];
      new SecureRandom().nextBytes(bytes);
      token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
      getConfig().set("token", token);
      saveConfig();
    }

    worldName = getConfig().getString("world", "");
    int bridgePort = getConfig().getInt("bridge-port", 8766);
    int dashboardPort = getConfig().getInt("dashboard-port", 8765);

    try {
      bridge = new BridgeServer(this, bridgePort, token);
      bridge.start();
      getLogger().info("Bridge listening on 127.0.0.1:" + bridgePort);
    } catch (IOException e) {
      getLogger().log(Level.SEVERE, "Could not open the bridge port " + bridgePort
          + ". Change bridge-port in plugins/mcAI/config.yml and restart.", e);
      return;
    }

    PluginCommand command = getCommand("mcai");
    if (command != null) {
      command.setExecutor(this);
      command.setTabCompleter(this);
    }

    if (getConfig().getBoolean("auto-start-engine", true)) {
      // The engine ships inside this jar, so there is no second download and
      // no version to keep in step by hand. Only ever unpack into the folder
      // we manage: a configured engine-path belongs to whoever set it.
      if (usingManagedEngine()) EngineInstaller.install(this, engineDirectory());
      engine = new EngineProcess(this, bridgePort, dashboardPort, token);
      engine.start();
    } else {
      getLogger().info("auto-start-engine is off. Start the engine yourself with:");
      getLogger().info("  MCAI_BRIDGE_TOKEN=" + token + " ./mcai serve --plugin");
    }

    getLogger().info("mcAI ready. Type /mcai in game to get started.");
  }

  @Override
  public void onDisable() {
    if (engine != null) engine.stop();
    if (bridge != null) bridge.stop();
  }

  // ── Accessors used by the bridge and the command handler ────────────────

  /** The world mcAI builds in. */
  public org.bukkit.World world() {
    if (worldName != null && !worldName.isEmpty()) {
      org.bukkit.World named = Bukkit.getWorld(worldName);
      if (named != null) return named;
    }
    List<org.bukkit.World> worlds = Bukkit.getWorlds();
    return worlds.isEmpty() ? null : worlds.get(0);
  }

  public String token() { return token; }

  public int dashboardPort() { return getConfig().getInt("dashboard-port", 8765); }

  /**
   * The dashboard address to hand someone.
   *
   * The engine guards its API with the same token the bridge uses, so the link
   * only works with the token in it. Anyone who can open that page can spend
   * the server's API key, so only admins get the full link; everyone else gets
   * the address and a pointer to ask.
   */
  private String dashboardUrl(CommandSender sender) {
    String base = "http://localhost:" + dashboardPort();
    return sender.hasPermission("mcai.admin") ? base + "?token=" + token : base;
  }

  public EngineProcess engine() { return engine; }

  File engineDirectory() {
    String configured = getConfig().getString("engine-path", "");
    if (configured != null && !configured.isEmpty()) return new File(configured);
    return new File(getDataFolder(), "engine");
  }

  /** True when the engine directory is ours to unpack into and replace. */
  private boolean usingManagedEngine() {
    String configured = getConfig().getString("engine-path", "");
    return configured == null || configured.isEmpty();
  }

  // ── /mcai ───────────────────────────────────────────────────────────────

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    String sub = args.length > 0 ? args[0].toLowerCase() : "help";

    switch (sub) {
      case "build":
      case "b": {
        if (!(sender instanceof Player)) {
          sender.sendMessage(Chat.error("Only a player can build — mcAI needs somewhere to put it."));
          return true;
        }
        if (!sender.hasPermission("mcai.build")) {
          sender.sendMessage(Chat.error("You do not have permission to build."));
          return true;
        }
        String prompt = join(args, 1);
        if (prompt.isEmpty()) {
          sender.sendMessage(Chat.info("Say what to build, for example: /mcai build a huge castle"));
          return true;
        }
        requestBuild((Player) sender, prompt);
        return true;
      }

      case "undo":
      case "u":
        if (!sender.hasPermission("mcai.build")) {
          sender.sendMessage(Chat.error("You do not have permission to undo."));
          return true;
        }
        post(sender, "/api/undo", "{}", "Undoing…");
        return true;

      case "cancel":
      case "stop":
        post(sender, "/api/cancel", "{}", "Cancelling…");
        return true;

      case "status":
      case "s":
        showStatus(sender);
        return true;

      case "style":
        setStyle(sender, join(args, 1));
        return true;

      case "list":
      case "structures":
        showLibrary(sender);
        return true;

      case "setup":
      case "ai":
        showSetup(sender);
        return true;

      case "dashboard":
      case "web":
        sender.sendMessage(Chat.info("Dashboard: " + dashboardUrl(sender)));
        if (!sender.hasPermission("mcai.admin")) {
          sender.sendMessage(Chat.dim("Ask an admin for the link with the access token."));
        }
        return true;

      case "reload":
        if (!sender.hasPermission("mcai.admin")) {
          sender.sendMessage(Chat.error("You do not have permission to do that."));
          return true;
        }
        reloadConfig();
        sender.sendMessage(Chat.ok("Config reloaded."));
        return true;

      default:
        showHelp(sender);
        return true;
    }
  }

  private void requestBuild(Player player, String prompt) {
    if (engine != null && !engine.isRunning()) {
      player.sendMessage(Chat.error("The mcAI engine is not running. /mcai status for details."));
      return;
    }

    // The player's exact position and facing travel with the request, so the
    // engine never has to look them up or guess.
    String body = "{\"prompt\":" + Json.string(prompt)
        + ",\"at\":{\"name\":" + Json.string(player.getName())
        + ",\"position\":[" + player.getLocation().getBlockX() + ","
        + player.getLocation().getBlockY() + "," + player.getLocation().getBlockZ() + "]"
        + ",\"yaw\":" + player.getLocation().getYaw() + "}}";

    player.sendMessage(Chat.info("Planning \"" + prompt + "\"…"));
    post(player, "/api/build", body, null);
  }

  /** Fire a request at the engine off the main thread, and report the outcome. */
  private void post(CommandSender sender, String path, String body, String pending) {
    if (pending != null) sender.sendMessage(Chat.info(pending));
    final String name = sender.getName();
    Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
      Http.Response res = Http.postJson(
          "http://127.0.0.1:" + dashboardPort() + path, body, token, 120_000);
      Bukkit.getScheduler().runTask(this, () -> {
        CommandSender target = Bukkit.getPlayerExact(name);
        if (target == null) target = Bukkit.getConsoleSender();
        if (res.status >= 200 && res.status < 300) {
          String message = Json.field(res.body, "label");
          if (Json.field(res.body, "blocks") != null) {
            target.sendMessage(Chat.ok("Restored " + Json.field(res.body, "blocks") + " blocks"
                + (message != null ? " (" + message + ")" : "") + "."));
          }
        } else if (res.status == 0) {
          target.sendMessage(Chat.error("The mcAI engine is not answering. /mcai status"));
        } else {
          String error = Json.field(res.body, "error");
          target.sendMessage(Chat.error(error != null ? error : "Request failed (" + res.status + ")"));
        }
      });
    });
  }

  private void showStatus(CommandSender sender) {
    sender.sendMessage(Chat.heading("mcAI"));
    org.bukkit.World w = world();
    sender.sendMessage(Chat.line("world", w == null ? "none" : w.getName()));
    sender.sendMessage(Chat.line("bridge", "listening"));
    if (engine == null) {
      sender.sendMessage(Chat.line("engine", "not managed (auto-start-engine is off)"));
    } else {
      sender.sendMessage(Chat.line("engine", engine.status()));
    }
    sender.sendMessage(Chat.line("dashboard", dashboardUrl(sender)));

    final String name = sender.getName();
    Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
      Http.Response res = Http.get("http://127.0.0.1:" + dashboardPort() + "/api/state", token, 5000);
      Bukkit.getScheduler().runTask(this, () -> {
        CommandSender target = Bukkit.getPlayerExact(name);
        if (target == null) target = Bukkit.getConsoleSender();
        if (res.status != 200) {
          target.sendMessage(Chat.error("The engine is not answering on port " + dashboardPort() + "."));
          if (engine != null) {
            for (String line : engine.recentOutput()) target.sendMessage(Chat.dim("  " + line));
          }
          return;
        }
        String model = Json.nested(res.body, "llm", "model");
        target.sendMessage(Chat.line("ai", model != null ? model
            : "not set up — /mcai setup"));
      });
    });
  }

  /**
   * `/mcai style` with no argument lists what is available; with one, sets it.
   *
   * The list is fetched rather than hard-coded, because dropping a JSON file
   * into the engine's styles/ folder adds a style without touching this jar.
   */
  private void setStyle(CommandSender sender, String name) {
    final String who = sender.getName();
    Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
      if (name.isEmpty()) {
        Http.Response res = Http.get("http://127.0.0.1:" + dashboardPort() + "/api/styles", token, 5000);
        List<String> names = res.status == 200 ? Json.values(res.body, "styles", "name") : null;
        reply(who, target -> {
          if (names == null || names.isEmpty()) {
            target.sendMessage(Chat.error("Could not read the style list. /mcai status"));
            return;
          }
          target.sendMessage(Chat.heading("Styles"));
          target.sendMessage(Chat.dim("  " + String.join(", ", names)));
          target.sendMessage(Chat.cmd("/mcai style auto", "match the biome (default)"));
        });
        return;
      }

      String body = "{\"style\":" + ("auto".equalsIgnoreCase(name) ? "null" : Json.string(name)) + "}";
      Http.Response res = Http.postJson(
          "http://127.0.0.1:" + dashboardPort() + "/api/style", body, token, 10_000);
      reply(who, target -> {
        if (res.status == 200) {
          String now = Json.field(res.body, "style");
          target.sendMessage(Chat.ok("Style: " + (now == null ? "auto — matched to the biome" : now)));
        } else {
          String error = Json.field(res.body, "error");
          target.sendMessage(Chat.error(error != null ? error : "Could not set the style."));
        }
      });
    });
  }

  /** The structures that build with no AI connected. */
  private void showLibrary(CommandSender sender) {
    final String who = sender.getName();
    Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
      Http.Response res = Http.get("http://127.0.0.1:" + dashboardPort() + "/api/prefabs", token, 5000);
      List<String> names = res.status == 200 ? Json.values(res.body, "prefabs", "name") : null;
      reply(who, target -> {
        if (names == null || names.isEmpty()) {
          target.sendMessage(Chat.error("Could not read the structure list. /mcai status"));
          return;
        }
        target.sendMessage(Chat.heading(names.size() + " structures, no AI needed"));
        target.sendMessage(Chat.dim("  " + String.join(", ", names)));
        target.sendMessage(Chat.cmd("/mcai build " + names.get(0), "try one"));
      });
    });
  }

  /** Run something on the main thread, addressed to whoever asked. */
  private void reply(String who, java.util.function.Consumer<CommandSender> what) {
    Bukkit.getScheduler().runTask(this, () -> {
      CommandSender target = Bukkit.getPlayerExact(who);
      if (target == null) target = Bukkit.getConsoleSender();
      what.accept(target);
    });
  }

  private void showSetup(CommandSender sender) {
    sender.sendMessage(Chat.heading("Connect an AI"));
    sender.sendMessage(Chat.dim("mcAI builds fifteen structures with no AI at all —"));
    sender.sendMessage(Chat.dim("try /mcai build castle right now. For anything else:"));
    sender.sendMessage("");
    sender.sendMessage(Chat.info("Open  " + Chat.WHITE + dashboardUrl(sender)));
    sender.sendMessage(Chat.dim("Click \"AI provider\", pick one, paste a key, Save."));
    sender.sendMessage("");
    sender.sendMessage(Chat.dim("Fourteen providers. Ollama and LM Studio run on your"));
    sender.sendMessage(Chat.dim("own machine and cost nothing."));
  }

  private void showHelp(CommandSender sender) {
    sender.sendMessage(Chat.heading("mcAI"));
    sender.sendMessage(Chat.cmd("/mcai build <what>", "build it where you stand"));
    sender.sendMessage(Chat.cmd("/mcai undo", "put the last build back"));
    sender.sendMessage(Chat.cmd("/mcai cancel", "stop the build in progress"));
    sender.sendMessage(Chat.cmd("/mcai list", "structures that need no AI"));
    sender.sendMessage(Chat.cmd("/mcai style <name>", "force a style, or auto"));
    sender.sendMessage(Chat.cmd("/mcai status", "engine, world and AI"));
    sender.sendMessage(Chat.cmd("/mcai setup", "connect an AI provider"));
    sender.sendMessage(Chat.cmd("/mcai dashboard", "open the web dashboard"));
  }

  @Override
  public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
    if (args.length == 1) {
      return prefix(List.of("build", "undo", "cancel", "list", "style",
          "status", "setup", "dashboard", "reload"), args[0]);
    }
    if (args.length == 2 && args[0].equalsIgnoreCase("style")) {
      List<String> styles = new java.util.ArrayList<>(cached("styles", "/api/styles"));
      styles.add(0, "auto");
      return prefix(styles, args[1]);
    }
    if (args.length == 2 && args[0].equalsIgnoreCase("build")) {
      // A structure name builds instantly with no AI, so completing those
      // first is also the cheapest suggestion we can make.
      List<String> options = new java.util.ArrayList<>(cached("prefabs", "/api/prefabs"));
      options.addAll(List.of("a", "an", "the"));
      return prefix(options, args[1]);
    }
    if (args.length > 2 && args[0].equalsIgnoreCase("build")) {
      return List.of("huge", "small", "ruined", "medieval", "japanese", "castle",
          "tower", "temple", "cottage", "bridge", "on the hill", "here");
    }
    return List.of();
  }

  private static List<String> prefix(List<String> options, String typed) {
    if (typed == null || typed.isEmpty()) return options;
    String lower = typed.toLowerCase();
    List<String> out = new java.util.ArrayList<>();
    for (String option : options) if (option.toLowerCase().startsWith(lower)) out.add(option);
    return out;
  }

  /**
   * Names from the engine, remembered between completions.
   *
   * Tab completion runs on the main thread and must return immediately, so a
   * cold cache returns nothing and fills itself for next time — a keystroke
   * later. Blocking here would stutter the server for everyone.
   */
  private final java.util.Map<String, List<String>> nameCache = new java.util.concurrent.ConcurrentHashMap<>();
  private final java.util.Set<String> nameFetches = java.util.concurrent.ConcurrentHashMap.newKeySet();

  private List<String> cached(String key, String route) {
    List<String> known = nameCache.get(key);
    if (known != null) return known;
    if (nameFetches.add(key)) {
      Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
        Http.Response res = Http.get("http://127.0.0.1:" + dashboardPort() + route, token, 5000);
        List<String> names = res.status == 200 ? Json.values(res.body, key, "name") : null;
        if (names != null && !names.isEmpty()) nameCache.put(key, names);
        nameFetches.remove(key);
      });
    }
    return List.of();
  }

  private static String join(String[] parts, int from) {
    StringBuilder sb = new StringBuilder();
    for (int i = from; i < parts.length; i++) {
      if (sb.length() > 0) sb.append(' ');
      sb.append(parts[i]);
    }
    return sb.toString().trim();
  }
}
