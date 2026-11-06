package dev.mcai.world;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.storage.TagValueInput;
import net.minecraft.util.ProblemReporter;

/**
 * Block state strings ↔ {@link BlockState} (+ optional block-entity SNBT).
 * Canonical form (ARCHITECTURE §3): namespace present, all properties, sorted by name.
 * Server thread only (uses an unsynchronized cache).
 */
public final class BlockStates {
	/** A parsed palette entry: either a state (+ optional NBT) or an error. */
	public record Parsed(BlockState state, CompoundTag nbt, String error) {
		public boolean ok() {
			return state != null;
		}
	}

	private static final Map<BlockState, String> CANONICAL = new IdentityHashMap<>();
	private static final Comparator<Property<?>> BY_NAME = Comparator.comparing(Property::getName);

	private BlockStates() {
	}

	/** Parse with the vanilla /setblock parser; never throws. */
	public static Parsed parse(HolderLookup<Block> blocks, String text) {
		if (text == null || text.isBlank()) {
			return new Parsed(null, null, "empty block state");
		}
		try {
			BlockStateParser.BlockResult r = BlockStateParser.parseForBlock(blocks, text.trim(), true);
			return new Parsed(r.blockState(), r.nbt(), null);
		} catch (CommandSyntaxException e) {
			return new Parsed(null, null, e.getMessage());
		} catch (RuntimeException e) {
			return new Parsed(null, null, "invalid block state '" + text + "': " + e);
		}
	}

	public static Parsed[] parseAll(HolderLookup<Block> blocks, String[] palette) {
		Parsed[] out = new Parsed[palette.length];
		for (int i = 0; i < palette.length; i++) {
			out[i] = parse(blocks, palette[i]);
		}
		return out;
	}

	/** Canonical state string without NBT. */
	public static String canonical(BlockState state) {
		String s = CANONICAL.get(state);
		if (s == null) {
			s = build(state);
			CANONICAL.put(state, s);
		}
		return s;
	}

	private static String build(BlockState state) {
		StringBuilder sb = new StringBuilder(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
		Collection<Property<?>> props = state.getProperties();
		if (!props.isEmpty()) {
			List<Property<?>> sorted = new ArrayList<>(props);
			sorted.sort(BY_NAME);
			sb.append('[');
			for (int i = 0; i < sorted.size(); i++) {
				if (i > 0) {
					sb.append(',');
				}
				Property<?> p = sorted.get(i);
				sb.append(p.getName()).append('=').append(valueName(state, p));
			}
			sb.append(']');
		}
		return sb.toString();
	}

	private static <T extends Comparable<T>> String valueName(BlockState state, Property<T> p) {
		return p.getName(state.getValue(p));
	}

	/** Canonical string plus {@code {snbt}} of the block entity at {@code pos}, if any and non-empty. */
	public static String withBlockEntity(ServerLevel level, BlockPos pos, BlockState state) {
		String base = canonical(state);
		if (!state.hasBlockEntity()) {
			return base;
		}
		BlockEntity be = level.getBlockEntity(pos);
		if (be == null) {
			return base;
		}
		CompoundTag tag = be.saveWithoutMetadata(level.registryAccess());
		return tag.isEmpty() ? base : base + tag;
	}

	/** Load SNBT data into the block entity at {@code pos} and sync it to clients. */
	public static boolean applyBlockEntity(ServerLevel level, BlockPos pos, BlockState state, CompoundTag nbt) {
		BlockEntity be = level.getBlockEntity(pos);
		if (be == null) {
			return false;
		}
		be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), nbt));
		be.setChanged();
		level.sendBlockUpdated(pos, state, state, Block.UPDATE_CLIENTS);
		return true;
	}
}
