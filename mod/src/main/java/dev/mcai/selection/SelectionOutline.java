package dev.mcai.selection;

import dev.mcai.item.McaiItems;
import dev.mcai.world.Dimensions;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.DustParticleOptions;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

/**
 * Draws the selection box edges with dust particles, visible only to its owner, while they
 * hold the wand (or for a few seconds after a change).
 */
public final class SelectionOutline {
	private static final int INTERVAL_TICKS = 5;
	private static final int SHOW_AFTER_CHANGE_TICKS = 200;
	private static final int MAX_POINTS = 600;
	private static final DustParticleOptions EDGE = new DustParticleOptions(0xFFB020, 0.9f);
	private static final DustParticleOptions CORNER1 = new DustParticleOptions(0xFF4040, 1.6f);
	private static final DustParticleOptions CORNER2 = new DustParticleOptions(0x40A0FF, 1.6f);

	private SelectionOutline() {
	}

	public static void tick(MinecraftServer server) {
		int now = server.getTickCount();
		if (now % INTERVAL_TICKS != 0 || Selections.all().isEmpty()) {
			return;
		}
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			UUID id = player.getUUID();
			Selection sel = Selections.all().get(id);
			if (sel == null || !sel.dimension().equals(Dimensions.id(player.level()))) {
				continue;
			}
			boolean holding = player.isHolding(McaiItems.ARCHITECT_WAND);
			if (!holding && now - Selections.changedAt(id) > SHOW_AFTER_CHANGE_TICKS) {
				continue;
			}
			draw(player.level(), player, sel);
		}
	}

	private static void draw(ServerLevel level, ServerPlayer player, Selection sel) {
		if (sel.pos1() != null) {
			cube(level, player, sel.pos1(), CORNER1);
		}
		if (sel.pos2() != null) {
			cube(level, player, sel.pos2(), CORNER2);
		}
		if (!sel.complete()) {
			return;
		}
		BlockPos a = sel.min();
		BlockPos b = sel.max().offset(1, 1, 1);
		double perimeter = 4.0 * (sel.sizeX() + sel.sizeY() + sel.sizeZ());
		double step = Math.max(0.5, perimeter / MAX_POINTS);
		double[] xs = {a.getX(), b.getX()};
		double[] ys = {a.getY(), b.getY()};
		double[] zs = {a.getZ(), b.getZ()};
		for (double y : ys) {
			for (double z : zs) {
				line(level, player, a.getX(), y, z, b.getX(), y, z, step);
			}
		}
		for (double x : xs) {
			for (double z : zs) {
				line(level, player, x, a.getY(), z, x, b.getY(), z, step);
			}
		}
		for (double x : xs) {
			for (double y : ys) {
				line(level, player, x, y, a.getZ(), x, y, b.getZ(), step);
			}
		}
	}

	private static void cube(ServerLevel level, ServerPlayer player, BlockPos p, DustParticleOptions dust) {
		for (int i = 0; i < 8; i++) {
			level.sendParticles(player, dust, true, false, p.getX() + (i & 1), p.getY() + (i >> 1 & 1), p.getZ() + (i >> 2 & 1), 1, 0, 0, 0, 0);
		}
	}

	private static void line(ServerLevel level, ServerPlayer player, double x0, double y0, double z0, double x1, double y1, double z1, double step) {
		double len = Math.max(Math.abs(x1 - x0), Math.max(Math.abs(y1 - y0), Math.abs(z1 - z0)));
		int n = Math.max(1, (int) Math.ceil(len / step));
		for (int i = 0; i <= n; i++) {
			double t = (double) i / n;
			level.sendParticles(player, EDGE, true, false, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t, 1, 0, 0, 0, 0);
		}
	}
}
