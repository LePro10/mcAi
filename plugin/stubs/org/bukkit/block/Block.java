package org.bukkit.block;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.Biome;
public interface Block {
  BlockData getBlockData();
  Biome getBiome();
  boolean isEmpty();
}
