package dev.mcai.world;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;

/**
 * get_blocks: reads a box into a dense palette volume (x fastest, then z, then y; palette[0] =
 * air) section by section, loading/generating chunks as needed, within the tick budget.
 * With {@code blockEntities}, palette entries of block-entity blocks carry their SNBT.
 */
public final class ReadBlocksTask implements TickTask {
	public record Result(List<String> palette, char[] data) {
	}

	private final ServerLevel level;
	private final BlockBox box;
	private final boolean blockEntities;
	private final CompletableFuture<Result> future = new CompletableFuture<>();
	private final char[] data;
	private final List<String> palette = new ArrayList<>();
	private final IdentityHashMap<BlockState, Character> stateIndex = new IdentityHashMap<>();
	private final HashMap<String, Character> stringIndex = new HashMap<>();
	private final BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
	private final ChunkTickets tickets;
	private final int minCx, maxCx, minCz, maxCz, minSy, maxSy;
	private int cx, cz, sy;

	public ReadBlocksTask(ServerLevel level, BlockBox box, boolean blockEntities) {
		this.level = level;
		// clamp y to the world; outside rows stay air (index 0)
		this.box = box;
		this.tickets = new ChunkTickets(level);
		this.blockEntities = blockEntities;
		this.data = new char[(int) box.volume()];
		index("minecraft:air", Blocks.AIR.defaultBlockState());
		minCx = box.minX() >> 4;
		maxCx = box.maxX() >> 4;
		minCz = box.minZ() >> 4;
		maxCz = box.maxZ() >> 4;
		minSy = Math.max(box.minY(), level.getMinY()) >> 4;
		maxSy = Math.min(box.maxY(), level.getMaxY()) >> 4;
		cx = minCx;
		cz = minCz;
		sy = minSy;
	}

	public CompletableFuture<Result> future() {
		return future;
	}

	@Override
	public boolean step(long deadline) {
		if (minSy > maxSy) { // box entirely outside the world height
			future.complete(new Result(palette, data));
			return true;
		}
		while (cz <= maxCz) {
			tickets.hold(cx << 4, cz << 4);
			LevelChunk chunk = level.getChunk(cx, cz);
			while (sy <= maxSy) {
				readSection(chunk, sy);
				sy++;
				if (System.nanoTime() > deadline) {
					return false;
				}
			}
			sy = minSy;
			if (++cx > maxCx) {
				cx = minCx;
				cz++;
			}
		}
		tickets.releaseAll();
		future.complete(new Result(palette, data));
		return true;
	}

	private void readSection(LevelChunk chunk, int sectionY) {
		LevelChunkSection section = chunk.getSection(level.getSectionIndexFromSectionY(sectionY));
		if (section.hasOnlyAir()) {
			return; // data is already 0 = air
		}
		int x0 = Math.max(box.minX(), cx << 4), x1 = Math.min(box.maxX(), (cx << 4) + 15);
		int z0 = Math.max(box.minZ(), cz << 4), z1 = Math.min(box.maxZ(), (cz << 4) + 15);
		int y0 = Math.max(box.minY(), sectionY << 4), y1 = Math.min(box.maxY(), (sectionY << 4) + 15);
		int sx = box.sizeX();
		int sxz = sx * box.sizeZ();
		for (int y = y0; y <= y1; y++) {
			int rowY = (y - box.minY()) * sxz;
			for (int z = z0; z <= z1; z++) {
				int row = rowY + (z - box.minZ()) * sx - box.minX();
				for (int x = x0; x <= x1; x++) {
					BlockState s = section.getBlockState(x & 15, y & 15, z & 15);
					data[row + x] = blockEntities && s.hasBlockEntity() ? withNbt(x, y, z, s) : index(null, s);
				}
			}
		}
	}

	private char withNbt(int x, int y, int z, BlockState s) {
		String str = BlockStates.withBlockEntity(level, pos.set(x, y, z), s);
		Character c = stringIndex.get(str);
		return c != null ? c : add(str);
	}

	private char index(String known, BlockState s) {
		Character c = stateIndex.get(s);
		if (c != null) {
			return c;
		}
		String str = known != null ? known : BlockStates.canonical(s);
		Character byString = stringIndex.get(str);
		char idx = byString != null ? byString : add(str);
		stateIndex.put(s, idx);
		return idx;
	}

	private char add(String str) {
		if (palette.size() > Character.MAX_VALUE) {
			throw new IllegalStateException("more than 65536 distinct block states in the box");
		}
		char idx = (char) palette.size();
		palette.add(str);
		stringIndex.put(str, idx);
		return idx;
	}

	@Override
	public void fail(Throwable error) {
		tickets.releaseAll();
		future.completeExceptionally(error);
	}
}
