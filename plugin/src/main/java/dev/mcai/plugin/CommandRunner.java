package dev.mcai.plugin;

import org.bukkit.Bukkit;

/**
 * Runs a command as the console.
 *
 * Bukkit's dispatcher returns only a boolean, not the "Successfully filled 42
 * block(s)" text the engine counts blocks from. Rather than parse chat output,
 * the engine treats an empty reply as a no-op and relies on its own compiled
 * block counts — so what comes back here just has to distinguish success from
 * a command the server refused.
 */
final class CommandRunner {

  private CommandRunner() {}

  static String run(String command) {
    try {
      boolean ok = Bukkit.getServer().dispatchCommand(Bukkit.getConsoleSender(), command);
      // The engine's parser reads an empty string as "nothing to report",
      // which is the right answer for a command that ran.
      return ok ? "" : "Unknown or incomplete command: " + truncate(command);
    } catch (Throwable t) {
      // A single malformed command must not take down the batch, or the build.
      return "Command failed: " + truncate(command) + " — " + t.getClass().getSimpleName();
    }
  }

  private static String truncate(String s) {
    return s.length() <= 80 ? s : s.substring(0, 77) + "...";
  }
}
