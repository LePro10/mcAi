package dev.mcai.plugin;

/**
 * In-game message formatting.
 *
 * Legacy section-sign codes rather than the Adventure API, so the plugin runs
 * unchanged on Spigot, Paper and every fork in between.
 */
final class Chat {

  private Chat() {}

  static final String GREEN = "§a";
  static final String GRAY = "§7";
  static final String DARK = "§8";
  static final String RED = "§c";
  static final String WHITE = "§f";
  static final String AQUA = "§b";
  static final String BOLD = "§l";
  static final String RESET = "§r";

  private static final String TAG = DARK + "[" + GREEN + "mcAI" + DARK + "] " + RESET;

  static String info(String message) { return TAG + GRAY + message; }
  static String ok(String message) { return TAG + GREEN + message; }
  static String error(String message) { return TAG + RED + message; }
  static String dim(String message) { return DARK + message; }

  static String heading(String title) { return DARK + "── " + GREEN + BOLD + title + DARK + " ──"; }

  static String line(String key, String value) {
    return GRAY + "  " + key + DARK + " · " + WHITE + value;
  }

  static String cmd(String usage, String what) {
    return AQUA + "  " + usage + DARK + " — " + GRAY + what;
  }
}
