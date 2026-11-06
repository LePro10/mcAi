package dev.mcai.world;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Runs {@code count} cheap samples (heightmap columns, biome points) in index order within the
 * tick budget; the sampler writes results itself.
 */
public final class ColumnSampleTask<R> implements TickTask {
	/** Computes sample {@code i}. */
	public interface Sampler {
		void sample(int i);
	}

	private final int count;
	private final Sampler sampler;
	private final Supplier<R> result;
	private final CompletableFuture<R> future = new CompletableFuture<>();
	private int cursor;

	public ColumnSampleTask(int count, Sampler sampler, Supplier<R> result) {
		this.count = count;
		this.sampler = sampler;
		this.result = result;
	}

	public CompletableFuture<R> future() {
		return future;
	}

	@Override
	public boolean step(long deadline) {
		while (cursor < count) {
			sampler.sample(cursor++);
			if ((cursor & 31) == 0 && System.nanoTime() > deadline) {
				return false;
			}
		}
		future.complete(result.get());
		return true;
	}

	@Override
	public void fail(Throwable error) {
		future.completeExceptionally(error);
	}
}
