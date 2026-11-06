package dev.mcai.client;

import dev.mcai.build.JobTracker;
import dev.mcai.net.McaiPayloads;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import net.minecraft.core.BlockPos;

/** What the client knows from the server (status, current job, selection). Render thread. */
public final class ClientState {
	/** One "thought" line in the HUD (fades with age). */
	public record Thought(String text, long atMillis) {
	}

	public static final int MAX_THOUGHTS = 3;

	private static McaiPayloads.Status status;
	private static McaiPayloads.JobUpdate job;
	private static long jobUpdatedAt;
	private static final Deque<Thought> thoughts = new ArrayDeque<>();
	private static McaiPayloads.SelectionSync selection;
	private static McaiPayloads.JobArea area;

	public static McaiPayloads.JobArea area() {
		return area;
	}

	public static void area(McaiPayloads.JobArea a) {
		area = a;
	}

	private ClientState() {
	}

	public static McaiPayloads.Status status() {
		return status;
	}

	public static void status(McaiPayloads.Status s) {
		status = s;
	}

	public static McaiPayloads.JobUpdate job() {
		return job;
	}

	public static long jobUpdatedAt() {
		return jobUpdatedAt;
	}

	public static List<Thought> thoughts() {
		return List.copyOf(thoughts);
	}

	public static void job(McaiPayloads.JobUpdate u) {
		boolean newJob = job == null || !job.jobId().equals(u.jobId());
		if (newJob) {
			thoughts.clear();
		}
		String prompt = u.prompt().isEmpty() && job != null && !newJob ? job.prompt() : u.prompt();
		job = new McaiPayloads.JobUpdate(u.jobId(), u.state(), u.progress(), u.stage(), u.detail(), u.costUsd(), prompt);
		jobUpdatedAt = System.currentTimeMillis();
		String line = !u.detail().isBlank() ? u.detail().strip() : "";
		if (!line.isEmpty() && (thoughts.isEmpty() || !thoughts.peekLast().text().equals(line))) {
			thoughts.addLast(new Thought(line, jobUpdatedAt));
			while (thoughts.size() > MAX_THOUGHTS) {
				thoughts.removeFirst();
			}
		}
	}

	/** A job is running (Build disabled, Cancel offered). */
	public static boolean jobRunning() {
		if (job != null && !JobTracker.terminal(job.state())) {
			return true;
		}
		return status != null && !status.activeJob().isEmpty();
	}

	public static McaiPayloads.SelectionSync selection() {
		return selection;
	}

	public static void selection(McaiPayloads.SelectionSync s) {
		selection = s;
	}

	/** Selection size if complete and in the given dimension, else null. */
	public static int[] selectionSize(String dimension) {
		McaiPayloads.SelectionSync s = selection;
		if (s == null || s.pos1() == null || s.pos2() == null || !s.dimension().equals(dimension)) {
			return null;
		}
		BlockPos a = s.pos1();
		BlockPos b = s.pos2();
		return new int[] {Math.abs(a.getX() - b.getX()) + 1, Math.abs(a.getY() - b.getY()) + 1, Math.abs(a.getZ() - b.getZ()) + 1};
	}

	public static void reset() {
		status = null;
		job = null;
		thoughts.clear();
		selection = null;
		area = null;
	}
}
