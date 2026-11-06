package dev.mcai.world;

/** A unit of world work spread over server ticks by {@link TickScheduler}. */
public interface TickTask {
	/**
	 * Do work until finished or {@code deadlineNanos} ({@link System#nanoTime()}) passes.
	 * @return true when finished; false to continue next tick
	 */
	boolean step(long deadlineNanos);

	/** Abort with an error (exception in step, server stopping, ...). */
	void fail(Throwable error);
}
