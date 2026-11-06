package dev.mcai.world;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Blocks the engine may not create from scratch (config {@code allowCommandBlocks} lifts this):
 * command / structure / jigsaw / test blocks with block-entity data, and any block entity whose
 * data contains a {@code run_command} click event (a sign runs it at game-master level for whoever
 * clicks it). Together this would bypass the command allowlist. Exact copies of such blocks that
 * mcAI saw in the world — the {@code previous} states of set_blocks (undo) and get_blocks with
 * block entities (copy/paste) — stay allowed. Server thread only.
 */
public final class BlockPolicy {
	private static final Set<String> GUARDED_BLOCKS = Set.of("minecraft:command_block", "minecraft:chain_command_block",
			"minecraft:repeating_command_block", "minecraft:structure_block", "minecraft:jigsaw", "minecraft:test_block",
			"minecraft:test_instance_block");
	private static final int MAX_SEEN = 4096;

	private record Key(BlockState state, CompoundTag tag) {
	}

	private final boolean allowAll;
	private final Map<Key, Boolean> seen = new LinkedHashMap<>(64, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<Key, Boolean> e) {
			return size() > MAX_SEEN;
		}
	};

	public BlockPolicy(boolean allowAll) {
		this.allowAll = allowAll;
	}

	/** Would this block (with this block-entity data) need the allowance? */
	public static boolean guarded(BlockState state, CompoundTag tag) {
		if (tag == null) {
			return false; // an empty command/structure block does nothing until an operator edits it
		}
		return GUARDED_BLOCKS.contains(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString())
				|| tag.toString().contains("run_command");
	}

	/** Remember a guarded block that exists in the world, so placing an exact copy back (undo, paste) works. */
	public void saw(BlockState state, CompoundTag tag) {
		if (guarded(state, tag)) {
			seen.put(new Key(state, tag.copy()), Boolean.TRUE);
		}
	}

	/** The palette entry, or an error entry if it is a guarded block that mcAI never saw in the world. */
	public BlockStates.Parsed check(BlockStates.Parsed p) {
		if (allowAll || !p.ok() || !guarded(p.state(), p.nbt()) || seen.containsKey(new Key(p.state(), p.nbt()))) {
			return p;
		}
		return new BlockStates.Parsed(null, null, BuiltInRegistries.BLOCK.getKey(p.state().getBlock())
				+ " with command/structure data or run_command click events is not placed by mcAI (allowCommandBlocks in config/mcai.json)");
	}
}
