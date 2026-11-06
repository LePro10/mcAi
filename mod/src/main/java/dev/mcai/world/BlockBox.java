package dev.mcai.world;

import com.google.gson.JsonObject;
import dev.mcai.protocol.Json;
import dev.mcai.protocol.ProtocolException;

/** Inclusive, normalized block box (ARCHITECTURE §3). */
public record BlockBox(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
	public static BlockBox fromJson(JsonObject box) {
		int[] a = Json.vec3(box, "min");
		int[] b = Json.vec3(box, "max");
		return new BlockBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
				Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]));
	}

	public int sizeX() {
		return maxX - minX + 1;
	}

	public int sizeY() {
		return maxY - minY + 1;
	}

	public int sizeZ() {
		return maxZ - minZ + 1;
	}

	public long volume() {
		return (long) sizeX() * sizeY() * sizeZ();
	}

	/** Throws if the volume exceeds {@code max} (keeps responses within sane memory bounds). */
	public BlockBox requireVolumeAtMost(long max) {
		if (volume() > max) {
			throw new ProtocolException("box volume " + volume() + " exceeds the limit of " + max);
		}
		return this;
	}
}
