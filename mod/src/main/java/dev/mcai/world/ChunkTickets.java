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
 * Keeps the chunks a long-running world task touches loaded until it finishes, so they are not
 * unloaded and reloaded between ticks (nobody may be nearby on a server). Not persisted.
 */
public final class ChunkTickets {
	/** Registered in {@link #register()}; loading only (no entity/block ticking). */
	public static TicketType TYPE;

	private final ServerLevel level;
	private final LongOpenHashSet held = new LongOpenHashSet();
	private long last = ChunkPos.INVALID_CHUNK_POS;

	public ChunkTickets(ServerLevel level) {
		this.level = level;
	}

	public static void register() {
		TYPE = Registry.register(BuiltInRegistries.TICKET_TYPE, Identifier.fromNamespaceAndPath("mcai", "world_task"),
				new TicketType(TicketType.NO_TIMEOUT, TicketType.FLAG_LOADING));
	}

	/** Hold the chunk containing block x/z (cheap when called repeatedly for the same chunk). */
	public void hold(int blockX, int blockZ) {
		long key = ChunkPos.pack(blockX >> 4, blockZ >> 4);
		if (key != last) {
			last = key;
			if (held.add(key)) {
				level.getChunkSource().addTicketWithRadius(TYPE, ChunkPos.unpack(key), 0);
			}
		}
	}

	public void releaseAll() {
		for (LongIterator it = held.iterator(); it.hasNext(); ) {
			level.getChunkSource().removeTicketWithRadius(TYPE, ChunkPos.unpack(it.nextLong()), 0);
		}
		held.clear();
		last = ChunkPos.INVALID_CHUNK_POS;
	}
}
