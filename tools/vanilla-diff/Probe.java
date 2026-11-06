// Ground-truth dump of per-state block facts, executed against the REAL (unobfuscated)
// Minecraft 26.3 server classes. Run by tools/vanilla-diff/probe.mjs:
//   java -cp <server-26.3.jar>:<libraries…> tools/vanilla-diff/Probe.java <out.jsonl>
// One JSON object per block state (props sorted by name, like the engine's canonical form).
// Direction masks: bit i = Direction.values()[i] = down, up, north, south, west, east.
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.ShulkerBoxBlock;
import net.minecraft.world.level.block.SupportType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.shapes.VoxelShape;

public class Probe {
	static String fmt(BlockState s) {
		StringBuilder b = new StringBuilder(BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString());
		TreeMap<String, String> props = new TreeMap<>();
		for (Property<?> p : s.getProperties()) props.put(p.getName(), name(s, p));
		if (!props.isEmpty()) {
			b.append('[');
			boolean first = true;
			for (Map.Entry<String, String> e : props.entrySet()) {
				if (!first) b.append(',');
				first = false;
				b.append(e.getKey()).append('=').append(e.getValue());
			}
			b.append(']');
		}
		return b.toString();
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	static String name(BlockState s, Property p) {
		return p.getName(s.getValue(p));
	}

	static String q(String s) {
		return '"' + s + '"';
	}

	public static void main(String[] args) throws Exception {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		var g = EmptyBlockGetter.INSTANCE;
		var p0 = BlockPos.ZERO;
		Direction[] dirs = Direction.values();
		try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Path.of(args[0])))) {
			for (Block block : BuiltInRegistries.BLOCK) {
				for (BlockState s : block.getStateDefinition().getPossibleStates()) {
					int full = 0, center = 0, rigid = 0, colFace = 0, supFace = 0;
					VoxelShape col = s.getCollisionShape(g, p0);
					VoxelShape sup = s.getBlockSupportShape(g, p0);
					for (int i = 0; i < dirs.length; i++) {
						Direction d = dirs[i];
						if (s.isFaceSturdy(g, p0, d, SupportType.FULL)) full |= 1 << i;
						if (s.isFaceSturdy(g, p0, d, SupportType.CENTER)) center |= 1 << i;
						if (s.isFaceSturdy(g, p0, d, SupportType.RIGID)) rigid |= 1 << i;
						if (Block.isFaceFull(col, d)) colFace |= 1 << i;
						if (Block.isFaceFull(sup, d)) supFace |= 1 << i;
					}
					boolean exception = block instanceof LeavesBlock || block instanceof ShulkerBoxBlock || s.is(Blocks.BARRIER)
							|| s.is(Blocks.CARVED_PUMPKIN) || s.is(Blocks.JACK_O_LANTERN) || s.is(Blocks.MELON) || s.is(Blocks.PUMPKIN);
					StringBuilder b = new StringBuilder();
					b.append("{\"s\":").append(q(fmt(s)));
					b.append(",\"cls\":").append(q(block.getClass().getSimpleName()));
					b.append(",\"full\":").append(full).append(",\"center\":").append(center).append(",\"rigid\":").append(rigid);
					b.append(",\"colFace\":").append(colFace).append(",\"supFace\":").append(supFace);
					b.append(",\"solidRender\":").append(s.isSolidRender());
					b.append(",\"occlude\":").append(s.canOcclude());
					b.append(",\"colFull\":").append(s.isCollisionShapeFullBlock(g, p0));
					b.append(",\"colEmpty\":").append(col.isEmpty());
					b.append(",\"legacySolid\":").append(s.isSolid());
					b.append(",\"conductor\":").append(s.isRedstoneConductor(g, p0));
					b.append(",\"exception\":").append(exception);
					b.append(",\"replaceable\":").append(s.canBeReplaced());
					b.append(",\"air\":").append(s.isAir());
					b.append(",\"skylight\":").append(s.propagatesSkylightDown());
					if (!s.getProperties().isEmpty()) {
						List<String> rot = new ArrayList<>();
						for (Rotation r : new Rotation[] {Rotation.CLOCKWISE_90, Rotation.CLOCKWISE_180, Rotation.COUNTERCLOCKWISE_90}) rot.add(q(fmt(s.rotate(r))));
						b.append(",\"rot\":[").append(String.join(",", rot)).append(']');
						// LEFT_RIGHT flips z (north<->south), FRONT_BACK flips x (east<->west)
						b.append(",\"mirLR\":").append(q(fmt(s.mirror(Mirror.LEFT_RIGHT))));
						b.append(",\"mirFB\":").append(q(fmt(s.mirror(Mirror.FRONT_BACK))));
					}
					b.append('}');
					out.println(b);
				}
			}
		}
		System.out.println("ok");
	}
}
