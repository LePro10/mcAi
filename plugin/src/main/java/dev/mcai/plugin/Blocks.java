package dev.mcai.plugin;

import org.bukkit.block.Block;

/** Block to command-ready spec string. */
final class Blocks {

  private Blocks() {}

  /**
   * The full block state, exactly as `/setblock` accepts it.
   *
   * `getAsString()` yields `minecraft:oak_stairs[facing=east,half=bottom,...]`.
   * Keeping every property is what lets undo restore a roof with its stairs
   * facing the way they were, rather than a pile of default-facing blocks.
   */
  static String spec(Block block) {
    try {
      String s = block.getBlockData().getAsString();
      return s.startsWith("minecraft:") ? s.substring("minecraft:".length()) : s;
    } catch (Throwable t) {
      return "air";
    }
  }
}
