package dev.mcai.world;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Runs {@code count} cheap samples (heightmap columns, biome points) in index order within the
 * tick budget; the sampler writes results itself.
 */
public final class ColumnSampleTask<R> implements TickTask {
	/** Computes sample {@code i}; returns false if its chunk is not loaded yet (retried next tick). */
	public interface Sampler {
		boolean sample(int i);
	}

	private final int count;
	private final Sampler sampler;
	private final Supplier<R> result;
	private final ChunkTickets tickets;
	private final String name;
	private final CompletableFuture<R> future = new CompletableFuture<>();
	private int cursor;

	public ColumnSampleTask(String name, int count, ChunkTickets tickets, Sampler sampler, Supplier<R> result) {
		this.name = name;
		this.count = count;
		this.tickets = tickets;
		this.sampler = sampler;
		this.result = result;
	}

	public CompletableFuture<R> future() {
		return future;
	}

	@Override
	public boolean step(long deadline) {
		while (cursor < count) {
			if (!sampler.sample(cursor)) {
				return false;
			}
			cursor++;
			if ((cursor & 31) == 0 && System.nanoTime() > deadline) {
				return false;
			}
		}
		tickets.releaseAll();
		future.complete(result.get());
		return true;
	}

	@Override
	public String toString() {
		return name + "(" + cursor + "/" + count + ")";
	}

	@Override
	public void fail(Throwable error) {
		tickets.releaseAll();
		future.completeExceptionally(error);
	}
}
