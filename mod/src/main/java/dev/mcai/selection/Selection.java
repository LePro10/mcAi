package dev.mcai.selection;

import com.google.gson.JsonObject;
import dev.mcai.protocol.Json;
import net.minecraft.core.BlockPos;

/** A player's two wand corners in one dimension. Either corner may still be unset. */
public record Selection(String dimension, BlockPos pos1, BlockPos pos2) {
	public boolean complete() {
		return pos1 != null && pos2 != null;
	}

	public BlockPos min() {
		return new BlockPos(Math.min(pos1.getX(), pos2.getX()), Math.min(pos1.getY(), pos2.getY()), Math.min(pos1.getZ(), pos2.getZ()));
	}

	public BlockPos max() {
		return new BlockPos(Math.max(pos1.getX(), pos2.getX()), Math.max(pos1.getY(), pos2.getY()), Math.max(pos1.getZ(), pos2.getZ()));
	}

	public int sizeX() {
		return max().getX() - min().getX() + 1;
	}

	public int sizeY() {
		return max().getY() - min().getY() + 1;
	}

	public int sizeZ() {
		return max().getZ() - min().getZ() + 1;
	}

	public long volume() {
		return (long) sizeX() * sizeY() * sizeZ();
	}

	/** Box JSON {min:[..], max:[..]} (ARCHITECTURE §3). */
	public JsonObject toBoxJson() {
		BlockPos a = min();
		BlockPos b = max();
		JsonObject box = new JsonObject();
		box.add("min", Json.array(a.getX(), a.getY(), a.getZ()));
		box.add("max", Json.array(b.getX(), b.getY(), b.getZ()));
		return box;
	}

	public Selection withPos1(String dim, BlockPos p) {
		return new Selection(dim, p, dim.equals(dimension) ? pos2 : null);
	}

	public Selection withPos2(String dim, BlockPos p) {
		return new Selection(dim, dim.equals(dimension) ? pos1 : null, p);
	}
}
