package dev.mcai.client.render;

import dev.mcai.client.ClientState;
import dev.mcai.item.McaiItems;
import dev.mcai.net.McaiPayloads;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.gizmos.GizmoStyle;
import net.minecraft.gizmos.Gizmos;
import net.minecraft.gizmos.TextGizmo;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Draws the wand selection while the player holds the wand: outline box, corner markers
 * (corner 1 red, corner 2 blue) and a "W × H × D" label, via the vanilla gizmo system.
 */
public final class SelectionRenderer {
	private static final int EDGE = 0xFFF2B84A;
	private static final int FILL = 0x14F2B84A;
	private static final int C1 = 0xFFFF5050;
	private static final int C2 = 0xFF50A8FF;

	private SelectionRenderer() {
	}

	/** While a job runs (and briefly after): its build area — selection gold, allowed margin faint white. */
	private static void drawJobArea(Minecraft mc) {
		McaiPayloads.JobArea a = ClientState.area();
		McaiPayloads.JobUpdate job = ClientState.job();
		if (a == null || !a.dimension().equals(mc.level.dimension().identifier().toString())) {
			return;
		}
		boolean active = job == null || !job.jobId().equals(a.jobId()) || !dev.mcai.build.JobTracker.terminal(job.state())
				|| System.currentTimeMillis() - ClientState.jobUpdatedAt() < AREA_LINGER_MS;
		if (!active) {
			return;
		}
		try (var ignored = mc.collectPerTickGizmos()) {
			Gizmos.cuboid(box(a.allowMin(), a.allowMax()).inflate(0.02), GizmoStyle.stroke(ALLOWED, 1.0f));
			if (a.selMin() != null) {
				Gizmos.cuboid(box(a.selMin(), a.selMax()).inflate(0.01), GizmoStyle.strokeAndFill(EDGE, 2.0f, 0x0CF2B84A));
			}
		}
	}

	private static AABB box(BlockPos min, BlockPos max) {
		return new AABB(min.getX(), min.getY(), min.getZ(), max.getX() + 1, max.getY() + 1, max.getZ() + 1);
	}

	private static final int ALLOWED = 0x99FFFFFF;
	private static final long AREA_LINGER_MS = 10_000;

	/** END_CLIENT_TICK: per-tick gizmos (drawn every frame until the next tick). */
	public static void tick(Minecraft mc) {
		if (mc.player == null || mc.level == null) {
			return;
		}
		drawJobArea(mc);
		if (!mc.player.isHolding(McaiItems.ARCHITECT_WAND)) {
			return;
		}
		McaiPayloads.SelectionSync s = ClientState.selection();
		if (s == null || !s.dimension().equals(mc.level.dimension().identifier().toString())) {
			return;
		}
		try (var ignored = mc.collectPerTickGizmos()) {
			if (s.pos1() != null) {
				Gizmos.cuboid(s.pos1(), 0.03f, GizmoStyle.strokeAndFill(C1, 2.5f, 0x30FF5050));
			}
			if (s.pos2() != null) {
				Gizmos.cuboid(s.pos2(), 0.03f, GizmoStyle.strokeAndFill(C2, 2.5f, 0x3050A8FF));
			}
			if (s.pos1() == null || s.pos2() == null) {
				return;
			}
			BlockPos a = s.pos1();
			BlockPos b = s.pos2();
			AABB box = new AABB(Math.min(a.getX(), b.getX()), Math.min(a.getY(), b.getY()), Math.min(a.getZ(), b.getZ()),
					Math.max(a.getX(), b.getX()) + 1, Math.max(a.getY(), b.getY()) + 1, Math.max(a.getZ(), b.getZ()) + 1);
			Gizmos.cuboid(box.inflate(0.01), GizmoStyle.strokeAndFill(EDGE, 2.0f, FILL));
			String label = (int) box.getXsize() + " × " + (int) box.getYsize() + " × " + (int) box.getZsize();
			Vec3 top = new Vec3(box.getCenter().x, box.maxY + 0.6, box.getCenter().z);
			float size = (float) Math.max(box.getXsize(), Math.max(box.getYsize(), box.getZsize()));
			Gizmos.billboardText(label, top, TextGizmo.Style.forColorAndCentered(0xFFFFFFFF).withScale(TextGizmo.Style.DEFAULT_SCALE * Math.max(3f, size / 4f)))
					.setAlwaysOnTop();
		}
	}
}
