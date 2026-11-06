package dev.mcai.selection;

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
		if (pos.equals(corner == 1 ? old.pos1() : old.pos2()) && dim.equals(old.dimension())) {
			return false;
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
		player.level().playSound(null, pos, SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.8f, corner == 1 ? 1.2f : 1.6f);
		return true;
	}

	public static void clear(ServerPlayer player) {
		SELECTIONS.remove(player.getUUID());
		CHANGED_AT.remove(player.getUUID());
	}

	public static void reset() {
		SELECTIONS.clear();
		CHANGED_AT.clear();
	}
}
