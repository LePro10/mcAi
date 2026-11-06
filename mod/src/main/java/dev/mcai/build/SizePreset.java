package dev.mcai.build;

import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

/**
 * Build-area presets used when the player does not use a wand selection. The box follows the
 * engine's default allowed box: centred on the anchor left/right, mostly in front of the player,
 * with room below the anchor for foundations (engine/src/server/hub.ts defaultAllowedBox).
 */
public enum SizePreset {
	S(16, 16, 16), M(32, 24, 32), L(48, 40, 48), XL(96, 64, 96);

	public static final int DEPTH_BELOW = 12;

	public final int x;
	public final int y;
	public final int z;

	SizePreset(int x, int y, int z) {
		this.x = x;
		this.y = y;
		this.z = z;
	}

	public static SizePreset parse(String s) {
		try {
			return valueOf(s.toUpperCase(Locale.ROOT));
		} catch (RuntimeException e) {
			return M;
		}
	}

	/** World box [min, max] for an anchor (ground block) and the player's facing. */
	public BlockPos[] box(BlockPos anchor, Direction facing, int minY, int maxY) {
		int front = Math.min(8, z / 6);
		int lx0 = -(x / 2), lx1 = x - x / 2 - 1;
		int lz0 = -(z - 1 - front), lz1 = front;
		int turns = switch (facing) {
			case EAST -> 1;
			case SOUTH -> 2;
			case WEST -> 3;
			default -> 0;
		};
		int[] a = rot(lx0, lz0, turns);
		int[] b = rot(lx1, lz1, turns);
		BlockPos min = new BlockPos(anchor.getX() + Math.min(a[0], b[0]), Math.max(minY, anchor.getY() - DEPTH_BELOW), anchor.getZ() + Math.min(a[1], b[1]));
		BlockPos max = new BlockPos(anchor.getX() + Math.max(a[0], b[0]), Math.min(maxY, anchor.getY() + y - 1), anchor.getZ() + Math.max(a[1], b[1]));
		return new BlockPos[] {min, max};
	}

	private static int[] rot(int x, int z, int turns) {
		return switch (turns) {
			case 1 -> new int[] {-z, x};
			case 2 -> new int[] {-x, -z};
			case 3 -> new int[] {z, -x};
			default -> new int[] {x, z};
		};
	}
}
