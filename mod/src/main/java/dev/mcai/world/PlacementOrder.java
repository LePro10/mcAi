package dev.mcai.world;

import java.util.Arrays;

/** Visual build order for set_blocks ({@code animate}). Returns null for input order. */
final class PlacementOrder {
	private static final int INDEX_BITS = 22; // PlaceBlocksTask.MAX_BLOCKS

	private PlacementOrder() {
	}

	static int[] compute(int[] positions, int n, String animate) {
		if (animate == null || n < 2) {
			return null;
		}
		return switch (animate) {
			case "layers" -> layers(positions, n);
			case "sweep" -> sweep(positions, n);
			default -> null;
		};
	}

	/** Bottom layer first; within a layer from the batch's horizontal centre outwards. */
	private static int[] layers(int[] p, int n) {
		double cx = 0;
		double cz = 0;
		for (int i = 0; i < n; i++) {
			cx += p[i * 3];
			cz += p[i * 3 + 2];
		}
		cx /= n;
		cz /= n;
		long[] keys = new long[n];
		for (int i = 0; i < n; i++) {
			long y = (p[i * 3 + 1] + 2048) & 0xFFF;
			long d = Math.min(0xFFFF, (long) Math.hypot(p[i * 3] - cx, p[i * 3 + 2] - cz));
			keys[i] = (y << 38) | (d << INDEX_BITS) | i;
		}
		return sorted(keys);
	}

	/** Bottom layer first, sweeping along x then z. */
	private static int[] sweep(int[] p, int n) {
		int minX = Integer.MAX_VALUE;
		int minZ = Integer.MAX_VALUE;
		for (int i = 0; i < n; i++) {
			minX = Math.min(minX, p[i * 3]);
			minZ = Math.min(minZ, p[i * 3 + 2]);
		}
		long[] keys = new long[n];
		for (int i = 0; i < n; i++) {
			long y = (p[i * 3 + 1] + 2048) & 0xFFF;
			long x = Math.min(0xFF, p[i * 3] - minX);
			long z = Math.min(0x7FF, p[i * 3 + 2] - minZ);
			keys[i] = (y << 41) | (x << 33) | (z << INDEX_BITS) | i;
		}
		return sorted(keys);
	}

	private static int[] sorted(long[] keys) {
		Arrays.parallelSort(keys);
		int[] order = new int[keys.length];
		long mask = (1L << INDEX_BITS) - 1;
		for (int i = 0; i < keys.length; i++) {
			order[i] = (int) (keys[i] & mask);
		}
		return order;
	}
}
