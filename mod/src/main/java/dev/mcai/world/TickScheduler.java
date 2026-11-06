package dev.mcai.world;

import dev.mcai.McaiMod;
import java.util.ArrayDeque;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * FIFO queue of world tasks, run at the end of each server tick within a wall-clock budget so
 * the server never lags. Tasks run strictly in arrival order (a get_blocks sent after a
 * set_blocks sees its result). {@link #submit} is thread-safe; everything else runs on the
 * server thread.
 */
public final class TickScheduler {
	private final ConcurrentLinkedQueue<TickTask> incoming = new ConcurrentLinkedQueue<>();
	private final ArrayDeque<TickTask> queue = new ArrayDeque<>();
	private final long budgetNanos;
	private final AtomicInteger pending = new AtomicInteger();

	public TickScheduler(double budgetMs) {
		this.budgetNanos = (long) (budgetMs * 1_000_000L);
	}

	public void submit(TickTask task) {
		incoming.add(task);
		pending.incrementAndGet();
	}

	public int size() {
		return pending.get();
	}

	/** Called from END_SERVER_TICK. */
	public void tick() {
		TickTask t;
		while ((t = incoming.poll()) != null) {
			queue.add(t);
		}
		long deadline = System.nanoTime() + budgetNanos;
		while (!queue.isEmpty() && System.nanoTime() < deadline) {
			TickTask task = queue.peek();
			boolean done;
			try {
				done = task.step(deadline);
			} catch (Throwable e) {
				McaiMod.LOG.error("mcai: world task failed", e);
				task.fail(e);
				done = true;
			}
			if (!done) {
				break; // budget or the task's own per-tick limit reached; keep order
			}
			queue.poll();
			pending.decrementAndGet();
		}
	}

	/** Fail every queued task (server stopping). */
	public void cancelAll(String reason) {
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
