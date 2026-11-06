package dev.mcai.world;

import dev.mcai.McaiMod;
import java.util.ArrayDeque;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * World work on the server thread within a wall-clock budget per tick, in two FIFO queues:
 * <ul>
 *   <li>reads (get_blocks, heightmap, biomes) — never wait behind a long build; they get up to
 *       half the budget while writes are pending;</li>
 *   <li>writes (set_blocks) — strictly in arrival order.</li>
 * </ul>
 * A read sent while a write is still running may see part of that write (the engine awaits its
 * own writes before reading). {@link #submit}/{@link #submitRead} are thread-safe; {@link #tick}
 * runs on the server thread — from END_SERVER_TICK, or from the bridge's pump while the
 * integrated server is paused.
 */
public final class TickScheduler {
	private static final long SLOW_STEP_NANOS = 100_000_000L;

	private final Lane reads = new Lane("read");
	private final Lane writes = new Lane("write");
	private final long budgetNanos;
	private volatile long lastRunNanos = System.nanoTime();

	public TickScheduler(double budgetMs) {
		this.budgetNanos = (long) (budgetMs * 1_000_000L);
	}

	public void submit(TickTask task) {
		writes.add(task);
	}

	public void submitRead(TickTask task) {
		reads.add(task);
	}

	public int size() {
		return reads.pending.get() + writes.pending.get();
	}

	/** System.nanoTime() of the last {@link #tick}. */
	public long lastRunNanos() {
		return lastRunNanos;
	}

	public void tick() {
		long start = System.nanoTime();
		lastRunNanos = start;
		long deadline = start + budgetNanos;
		if (writes.pending.get() > 0) {
			reads.run(start + budgetNanos / 2);
			writes.run(deadline);
		} else {
			reads.run(deadline);
		}
	}

	public void cancelAll(String reason) {
		reads.cancel(reason);
		writes.cancel(reason);
	}

	private static final class Lane {
		final String name;
		final ConcurrentLinkedQueue<TickTask> incoming = new ConcurrentLinkedQueue<>();
		final ArrayDeque<TickTask> queue = new ArrayDeque<>();
		final AtomicInteger pending = new AtomicInteger();

		Lane(String name) {
			this.name = name;
		}

		void add(TickTask t) {
			incoming.add(t);
			pending.incrementAndGet();
		}

		void run(long deadline) {
			TickTask t;
			while ((t = incoming.poll()) != null) {
				queue.add(t);
			}
			while (!queue.isEmpty() && System.nanoTime() < deadline) {
				TickTask task = queue.peek();
				boolean done;
				long t0 = System.nanoTime();
				try {
					done = task.step(deadline);
				} catch (Throwable e) {
					McaiMod.LOG.error("mcai: world task failed", e);
					task.fail(e);
					done = true;
				}
				long took = System.nanoTime() - t0;
				if (took > SLOW_STEP_NANOS) {
					McaiMod.LOG.warn("mcai: slow {} step: {} took {} ms", name, task, took / 1_000_000);
				}
				if (!done) {
					break; // budget, per-tick limit or waiting for a chunk; keep order
				}
				queue.poll();
				pending.decrementAndGet();
			}
		}

		void cancel(String reason) {
			TickTask t;
			while ((t = incoming.poll()) != null) {
				queue.add(t);
			}
			while ((t = queue.poll()) != null) {
				t.fail(new IllegalStateException(reason));
			}
			pending.set(0);
		}
	}
}
