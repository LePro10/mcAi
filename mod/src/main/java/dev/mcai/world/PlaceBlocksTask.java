package dev.mcai.world;

import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

/**
 * set_blocks executor (ARCHITECTURE §5). Phases, all on the server thread within the tick budget:
 * <ol>
 *   <li>PLACE — record the previous state (+ block-entity SNBT) for undo, then place without
 *       neighbour updates, drops or onPlace side effects; apply block-entity SNBT.</li>
 *   <li>SHAPES — if updateShapes: vanilla {@link Block#updateFromNeighbourShapes} for every
 *       placed block, so fences/panes/walls/stairs connect. A shape result is only accepted
 *       if it keeps the block id (never lets a shape update delete a block, e.g. a lone door
 *       half or a plant on unsuitable ground).</li>
 *   <li>BOUNDARY — the same for existing blocks adjacent to the batch.</li>
 * </ol>
 */
public final class PlaceBlocksTask implements TickTask {
	public static final int MAX_BLOCKS = 1 << 22;
	private static final int PLACE_FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS;
	private static final int SHAPE_FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS;
	private static final Direction[] DIRECTIONS = Direction.values();

	public record Failure(int index, String reason) {
	}

	public record Result(int placed, int unchanged, List<Failure> failed, List<String> previousPalette,
			char[] previousStates, int shapeUpdates, int ticks, long nanos, long placeNanos, long shapeNanos) {
	}

	private enum Phase { PLACE, SHAPES, BOUNDARY, DONE }

	private final ServerLevel level;
	private final BlockStates.Parsed[] palette;
	private final int[] positions;
	private final char[] states;
	private final int[] order;
	private final boolean updateShapes;
	private final int maxPerTick;
	private final CompletableFuture<Result> future = new CompletableFuture<>();
	private final BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
	private final ChunkTickets tickets;

	private final int n;
	private final char[] previous;
	private final List<String> previousPalette = new ArrayList<>();
	private final HashMap<String, Character> previousIndex = new HashMap<>();
	private final List<Failure> failed = new ArrayList<>();
	private final BitSet changed;
	private final LongOpenHashSet batch;
	private final LongOpenHashSet boundarySet;
	private final LongArrayList boundary;

	private Phase phase = Phase.PLACE;
	private int cursor;
	private int placed;
	private int unchanged;
	private int shapeUpdates;
	private int ticks;
	private long startNanos;
	private long placeNanos;
	private long shapeNanos;

	public PlaceBlocksTask(ServerLevel level, BlockStates.Parsed[] palette, int[] positions, char[] states,
			boolean updateShapes, String animate, int maxPerTick) {
		this.level = level;
		this.tickets = new ChunkTickets(level);
		this.palette = palette;
		this.positions = positions;
		this.states = states;
		this.n = states.length;
		this.updateShapes = updateShapes;
		this.maxPerTick = Math.max(1, maxPerTick);
		this.order = PlacementOrder.compute(positions, n, animate);
		this.previous = new char[n];
		this.changed = new BitSet(n);
		this.batch = updateShapes ? new LongOpenHashSet(n) : null;
		this.boundarySet = updateShapes ? new LongOpenHashSet() : null;
		this.boundary = updateShapes ? new LongArrayList() : null;
		previousIndexOf("minecraft:air");
	}

	public CompletableFuture<Result> future() {
		return future;
	}

	@Override
	public boolean step(long deadline) {
		if (ticks++ == 0) {
			startNanos = System.nanoTime();
		}
		int ops = 0;
		long entered = System.nanoTime();
		try {
			return run(deadline, ops);
		} finally {
			long spent = System.nanoTime() - entered;
			if (phase == Phase.PLACE) {
				placeNanos += spent;
			} else {
				shapeNanos += spent;
			}
		}
	}

	private boolean run(long deadline, int ops) {
		while (true) {
			switch (phase) {
				case PLACE -> {
					while (cursor < n) {
						if (ops >= maxPerTick || ((ops & 63) == 0 && System.nanoTime() > deadline)) {
							return false;
						}
						placeOne(order == null ? cursor : order[cursor]);
						cursor++;
						ops++;
					}
					cursor = 0;
					phase = updateShapes ? Phase.SHAPES : Phase.DONE;
				}
				case SHAPES -> {
					while ((cursor = changed.nextSetBit(cursor)) >= 0) {
						if ((ops++ & 63) == 0 && System.nanoTime() > deadline) {
							return false;
						}
						int i = cursor++;
						long p = BlockPos.asLong(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
						fixShape(p);
						for (Direction d : DIRECTIONS) {
							long q = BlockPos.offset(p, d);
							if (!batch.contains(q) && boundarySet.add(q)) {
								boundary.add(q);
							}
						}
					}
					cursor = 0;
					phase = Phase.BOUNDARY;
				}
				case BOUNDARY -> {
					while (cursor < boundary.size()) {
						if ((ops++ & 63) == 0 && System.nanoTime() > deadline) {
							return false;
						}
						fixShape(boundary.getLong(cursor++));
					}
					phase = Phase.DONE;
				}
				case DONE -> {
					tickets.releaseAll();
					future.complete(new Result(placed, unchanged, failed, previousPalette, previous, shapeUpdates,
							ticks, System.nanoTime() - startNanos, placeNanos, shapeNanos));
					return true;
				}
			}
		}
	}

	private void placeOne(int i) {
		int x = positions[i * 3];
		int y = positions[i * 3 + 1];
		int z = positions[i * 3 + 2];
		if (level.isOutsideBuildHeight(y)) {
			previous[i] = 0;
			failed.add(new Failure(i, "y=" + y + " is outside the build height " + level.getMinY() + ".." + level.getMaxY()));
			return;
		}
		pos.set(x, y, z);
		tickets.hold(x, z);
		BlockState old = level.getBlockState(pos);
		previous[i] = previousIndexOf(old.hasBlockEntity() ? BlockStates.withBlockEntity(level, pos, old) : BlockStates.canonical(old));
		int s = states[i];
		if (s >= palette.length) {
			failed.add(new Failure(i, "palette index " + s + " out of range"));
			return;
		}
		BlockStates.Parsed target = palette[s];
		if (!target.ok()) {
			failed.add(new Failure(i, target.error()));
			return;
		}
		if (old == target.state() && target.nbt() == null) {
			unchanged++;
			return;
		}
		if (old != target.state()) {
			if (!level.setBlock(pos, target.state(), PLACE_FLAGS)) {
				failed.add(new Failure(i, "the world rejected the block"));
				return;
			}
		}
		if (target.nbt() != null) {
			BlockStates.applyBlockEntity(level, pos, target.state(), target.nbt());
		}
		placed++;
		changed.set(i);
		if (batch != null) {
			batch.add(pos.asLong());
		}
	}

	private void fixShape(long p) {
		pos.set(p);
		BlockState s = level.getBlockState(pos);
		if (s.getProperties().isEmpty()) {
			return; // only same-block results are accepted: a block without properties cannot change
		}
		BlockState u = Block.updateFromNeighbourShapes(s, level, pos);
		if (u != s && u.getBlock() == s.getBlock()) {
			level.setBlock(pos, u, SHAPE_FLAGS);
			shapeUpdates++;
		}
	}

	private char previousIndexOf(String state) {
		Character c = previousIndex.get(state);
		if (c == null) {
			if (previousPalette.size() > Character.MAX_VALUE) {
				throw new IllegalStateException("more than 65536 distinct previous states");
			}
			c = (char) previousPalette.size();
			previousPalette.add(state);
			previousIndex.put(state, c);
		}
		return c;
	}

	@Override
	public void fail(Throwable error) {
		tickets.releaseAll();
		future.completeExceptionally(error);
	}
}
