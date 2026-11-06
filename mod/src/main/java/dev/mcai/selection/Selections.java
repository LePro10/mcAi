package dev.mcai.selection;

import dev.mcai.net.ServerNetworking;
import dev.mcai.ui.Msg;
import dev.mcai.world.Dimensions;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;

/** Per-player wand selections (in memory, per server run). */
public final class Selections {
	private static final Map<UUID, Selection> SELECTIONS = new ConcurrentHashMap<>();
	private static final Map<UUID, Integer> CHANGED_AT = new ConcurrentHashMap<>();
	/** Selections already used for a build: the next corner click starts a new selection. */
	private static final java.util.Set<UUID> USED = ConcurrentHashMap.newKeySet();
	/** A corner further away than this (any axis) from the other one is treated as stale. */
	public static final int MAX_SPAN = 160;

	private Selections() {
	}

	public static Selection get(ServerPlayer player) {
		return SELECTIONS.get(player.getUUID());
	}

	public static Map<UUID, Selection> all() {
		return SELECTIONS;
	}

	/** Tick of the last change (the outline is shown for a while after a change). */
	public static int changedAt(UUID player) {
		return CHANGED_AT.getOrDefault(player, Integer.MIN_VALUE);
	}

	/** Set corner 1 or 2; returns false if nothing changed. Informs the player. */
	public static boolean set(ServerPlayer player, int corner, BlockPos pos) {
		String dim = Dimensions.id(player.level());
		Selection old = SELECTIONS.getOrDefault(player.getUUID(), new Selection(dim, null, null));
		if (pos.equals(corner == 1 ? old.pos1() : old.pos2()) && dim.equals(old.dimension()) && !USED.contains(player.getUUID())) {
			return false;
		}
		Component note = null;
		if (USED.remove(player.getUUID())) {
			old = new Selection(dim, null, null); // the last selection was built in: start a new one
			note = Msg.tr("mcai.selection.new", "New selection started (the previous one was used for a build).");
		}
		BlockPos other = corner == 1 ? old.pos2() : old.pos1();
		if (other != null && dim.equals(old.dimension()) && span(pos, other) > MAX_SPAN) {
			old = new Selection(dim, null, null);
			note = Msg.tr("mcai.selection.far", "Corner %s was %s blocks away and was reset — set it again.", corner == 1 ? 2 : 1, span(pos, other));
		}
		Selection sel = corner == 1 ? old.withPos1(dim, pos.immutable()) : old.withPos2(dim, pos.immutable());
		SELECTIONS.put(player.getUUID(), sel);
		CHANGED_AT.put(player.getUUID(), player.level().getServer().getTickCount());
		Component where = Component.literal(pos.getX() + ", " + pos.getY() + ", " + pos.getZ());
		Component msg = sel.complete()
				? Msg.tr("mcai.selection.corner_size", "Corner %s set to %s (%s × %s × %s = %s blocks)", corner, where,
						sel.sizeX(), sel.sizeY(), sel.sizeZ(), sel.volume())
				: Msg.tr("mcai.selection.corner", "Corner %s set to %s", corner, where);
		player.sendSystemMessage(Msg.prefixed(msg));
		if (note != null) {
			player.sendSystemMessage(Msg.prefixed(note.copy().withStyle(net.minecraft.ChatFormatting.GRAY)));
		}
		player.level().playSound(null, pos, SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.8f, corner == 1 ? 1.2f : 1.6f);
		ServerNetworking.sendSelection(player);
		return true;
	}

	private static int span(BlockPos a, BlockPos b) {
		return Math.max(Math.abs(a.getX() - b.getX()), Math.max(Math.abs(a.getY() - b.getY()), Math.abs(a.getZ() - b.getZ()))) + 1;
	}

	/** The selection was sent with a build request. */
	public static void markUsed(ServerPlayer player) {
		USED.add(player.getUUID());
	}

	public static void clear(ServerPlayer player) {
		USED.remove(player.getUUID());
		SELECTIONS.remove(player.getUUID());
		CHANGED_AT.remove(player.getUUID());
		ServerNetworking.sendSelection(player);
	}

	public static void reset() {
		USED.clear();
		SELECTIONS.clear();
		CHANGED_AT.clear();
	}
}
