package dev.mcai.world;

import it.unimi.dsi.fastutil.longs.LongIterator;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;

/**
 * Chunk access for long-running world tasks without blocking the server thread: a non-persistent
 * ticket makes the chunk system load (or generate) the chunk on its worker threads; the task
 * yields until the chunk is ready, and keeps it loaded until the task ends.
 */
public final class ChunkTickets {
	/** Registered in {@link #register()}; loading only (no entity/block ticking). */
	public static TicketType TYPE;
	/** After a task, chunks stay loaded ~15 s so the engine's next read/write there does not reload them. */
	public static TicketType LINGER;
	/** A chunk that is not ready after this many checks (ticks) fails the task. */
	private static final int MAX_WAIT_TICKS = 20 * 60;
	private static final int MAX_PREFETCH = 4096;

	private final ServerLevel level;
	private final LongOpenHashSet held = new LongOpenHashSet();
	private long lastReady = ChunkPos.INVALID_CHUNK_POS;
	private long waitingFor = ChunkPos.INVALID_CHUNK_POS;
	private int waitTicks;
	private int totalWaits;

	public ChunkTickets(ServerLevel level) {
		this.level = level;
	}

	public static void register() {
		TYPE = Registry.register(BuiltInRegistries.TICKET_TYPE, Identifier.fromNamespaceAndPath("mcai", "world_task"),
				new TicketType(TicketType.NO_TIMEOUT, TicketType.FLAG_LOADING));
		LINGER = Registry.register(BuiltInRegistries.TICKET_TYPE, Identifier.fromNamespaceAndPath("mcai", "recent_task"),
				new TicketType(300L, TicketType.FLAG_LOADING | TicketType.FLAG_CAN_EXPIRE_IF_UNLOADED));
	}

	/**
	 * True if the chunk at chunk coords cx/cz is loaded (FULL). Otherwise requests it
	 * asynchronously and returns false; call again on a later tick.
	 * @throws IllegalStateException if the chunk does not load within a minute
	 */
	public boolean ready(int cx, int cz) {
		long key = ChunkPos.pack(cx, cz);
		if (key == lastReady) {
			return true;
		}
		if (held.add(key)) {
			level.getChunkSource().addTicketWithRadius(TYPE, ChunkPos.unpack(key), 0);
		}
		if (level.getChunkSource().getChunkNow(cx, cz) != null) {
			lastReady = key;
			waitingFor = ChunkPos.INVALID_CHUNK_POS;
			return true;
		}
		if (key != waitingFor) {
			waitingFor = key;
			waitTicks = 0;
			totalWaits++;
		} else if (++waitTicks > MAX_WAIT_TICKS) {
			throw new IllegalStateException("chunk " + cx + "," + cz + " did not load within 60 s");
		}
		return false;
	}

	/**
	 * Request chunks up front (loaded/generated in parallel on the worker threads) so the task
	 * does not wait for them one by one. At most {@code MAX_PREFETCH} chunks.
	 */
	public void prefetch(it.unimi.dsi.fastutil.longs.LongCollection chunkKeys) {
		int n = 0;
		for (LongIterator it = chunkKeys.iterator(); it.hasNext() && n < MAX_PREFETCH; n++) {
			long key = it.nextLong();
			if (held.add(key)) {
				level.getChunkSource().addTicketWithRadius(TYPE, ChunkPos.unpack(key), 0);
			}
		}
	}

	/** Ready check for a block position and (on chunk edges) the neighbouring chunks it touches. */
	public boolean readyAround(int x, int z) {
		int cx = x >> 4;
		int cz = z >> 4;
		int lx = x & 15;
		int lz = z & 15;
		return ready(cx, cz)
				&& (lx != 0 || ready(cx - 1, cz)) && (lx != 15 || ready(cx + 1, cz))
				&& (lz != 0 || ready(cx, cz - 1)) && (lz != 15 || ready(cx, cz + 1))
				&& ready(cx, cz);
	}

	/** Chunks that had to be loaded/generated (diagnostics). */
	public int waits() {
		return totalWaits;
	}

	public void releaseAll() {
		for (LongIterator it = held.iterator(); it.hasNext(); ) {
			ChunkPos pos = ChunkPos.unpack(it.nextLong());
			level.getChunkSource().addTicketWithRadius(LINGER, pos, 0);
			level.getChunkSource().removeTicketWithRadius(TYPE, pos, 0);
		}
		held.clear();
		lastReady = ChunkPos.INVALID_CHUNK_POS;
	}
}
