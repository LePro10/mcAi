package dev.mcai.world;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SupportType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.shapes.BooleanOp;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;

/**
 * Dumps every registered block (vanilla + modded) in the BlockRegistry JSON shape of
 * ARCHITECTURE §3: properties (values in registry order), defaults, map color, tags — plus the
 * per-state "registry physics" (ARCHITECTURE §5): sturdy faces (FULL/CENTER/RIGID), collision and
 * support face fullness, solid render, legacy isSolid, redstone conductor / signal source,
 * replaceable, the bottom collision face as walls see it. The engine uses these instead of id
 * heuristics. Format and algorithm match engine/src/core/physics.ts (buildPhysicsTable) and
 * tools/vanilla-diff/Probe.java; the harness checks the hello table against the real classes.
 * Call on the server thread after tags are bound (SERVER_STARTED or later).
 */
public final class RegistryDump {
	/** engine/src/core/physics.ts PHYSICS_FORMAT */
	public static final int PHYSICS_FORMAT = 1;
	private static final Direction[] DIRS = Direction.values(); // down, up, north, south, west, east
	// WallBlock.TEST_SHAPE_POST / TEST_SHAPES_WALL (private there; same construction)
	private static final VoxelShape TEST_POST = Block.column(2.0, 0.0, 16.0);
	private static final Map<Direction, VoxelShape> TEST_WALL = Shapes.rotateHorizontal(Block.boxZ(2.0, 16.0, 0.0, 9.0));

	private RegistryDump() {
	}

	public static JsonObject build() {
		JsonObject blocks = new JsonObject();
		List<Block> all = new ArrayList<>();
		BuiltInRegistries.BLOCK.forEach(all::add);
		all.sort(Comparator.comparing(b -> BuiltInRegistries.BLOCK.getKey(b).toString()));
		for (Block block : all) {
			blocks.add(BuiltInRegistries.BLOCK.getKey(block).toString(), describe(block));
		}
		JsonObject registry = new JsonObject();
		registry.addProperty("version", SharedConstants.getCurrentVersion().name());
		registry.add("blocks", blocks);
		registry.add("physics", physics(all));
		return registry;
	}

	// ------------------------------------------------------------------ physics

	/**
	 * Shape facts that only depend on the (shared, immutable) VoxelShape: face fullness per
	 * direction, plus for collision shapes the non-empty top face and the wall coverage bits
	 * (already in their flag positions). Cached by identity — most states share a few shapes.
	 */
	private record ShapeFacts(int faces, int flags) {
	}

	private static ShapeFacts shapeFacts(VoxelShape shape, boolean collision, Map<VoxelShape, ShapeFacts> cache) {
		ShapeFacts f = cache.get(shape);
		if (f != null) {
			return f;
		}
		int faces = 0, flags = 0;
		for (int i = 0; i < DIRS.length; i++) {
			if (Block.isFaceFull(shape, DIRS[i])) faces |= 1 << i;
		}
		if (collision) {
			if (!shape.getFaceShape(Direction.UP).isEmpty()) flags |= 1 << 6;
			VoxelShape bottom = shape.getFaceShape(Direction.DOWN);
			if (covered(bottom, TEST_POST)) flags |= 1 << 8;
			for (int i = 2; i < DIRS.length; i++) {
				if (covered(bottom, TEST_WALL.get(DIRS[i]))) flags |= 1 << (9 + i - 2);
			}
		}
		f = new ShapeFacts(faces, flags);
		cache.put(shape, f);
		return f;
	}

	/** class tuple [full, center, rigid, collision, support, flags] of one state, or null if it needs a world */
	@SuppressWarnings("deprecation") // BlockState.isSolid: vanilla still uses it for signs, banners, farmland …
	static int[] physicsOf(BlockState s, Map<VoxelShape, ShapeFacts> colCache, Map<VoxelShape, ShapeFacts> supCache) {
		try {
			var g = EmptyBlockGetter.INSTANCE;
			var p0 = BlockPos.ZERO;
			ShapeFacts col = shapeFacts(s.getCollisionShape(g, p0), true, colCache);
			ShapeFacts sup = shapeFacts(s.getBlockSupportShape(g, p0), false, supCache);
			int full = 0, center = 0, rigid = 0;
			for (int i = 0; i < DIRS.length; i++) {
				Direction d = DIRS[i];
				if (s.isFaceSturdy(g, p0, d, SupportType.FULL)) full |= 1 << i;
				if (s.isFaceSturdy(g, p0, d, SupportType.CENTER)) center |= 1 << i;
				if (s.isFaceSturdy(g, p0, d, SupportType.RIGID)) rigid |= 1 << i;
			}
			int flags = col.flags();
			if (s.isSolidRender()) flags |= 1;
			if (s.isSolid()) flags |= 1 << 1;
			if (s.isRedstoneConductor(g, p0)) flags |= 1 << 2;
			if (s.canBeReplaced()) flags |= 1 << 3;
			if (s.isCollisionShapeFullBlock(g, p0)) flags |= 1 << 4;
			if (s.isSignalSource()) flags |= 1 << 5;
			if (s.propagatesSkylightDown()) flags |= 1 << 7;
			return new int[] {full, center, rigid, col.faces(), sup.faces(), flags};
		} catch (RuntimeException e) {
			return null; // modded block that needs a real world for its shapes → engine heuristics
		}
	}

	/** WallBlock.isCovered */
	private static boolean covered(VoxelShape above, VoxelShape test) {
		return !Shapes.joinIsNotEmpty(test, above, BooleanOp.ONLY_FIRST);
	}

	/**
	 * Compact table: distinct classes + per block either one class id or {p: relevant properties
	 * with their values, c: class ids mixed-radix over p (first property slowest)}.
	 */
	static JsonObject physics(List<Block> all) {
		Map<String, Integer> classIdx = new HashMap<>();
		Map<VoxelShape, ShapeFacts> colCache = new IdentityHashMap<>();
		Map<VoxelShape, ShapeFacts> supCache = new IdentityHashMap<>();
		JsonArray classes = new JsonArray();
		JsonObject out = new JsonObject();
		for (Block block : all) {
			List<BlockState> states = block.getStateDefinition().getPossibleStates();
			if (states.isEmpty()) {
				continue;
			}
			Map<BlockState, Integer> ids = new HashMap<>();
			boolean same = true;
			int first = Integer.MIN_VALUE;
			for (BlockState s : states) {
				int[] c = physicsOf(s, colCache, supCache);
				int id = -1;
				if (c != null) {
					String key = Arrays.toString(c);
					Integer known = classIdx.get(key);
					if (known == null) {
						known = classes.size();
						classIdx.put(key, known);
						JsonArray a = new JsonArray();
						for (int v : c) {
							a.add(v);
						}
						classes.add(a);
					}
					id = known;
				}
				ids.put(s, id);
				if (first == Integer.MIN_VALUE) {
					first = id;
				} else if (first != id) {
					same = false;
				}
			}
			String name = BuiltInRegistries.BLOCK.getKey(block).toString();
			if (same) {
				out.addProperty(name, first);
				continue;
			}
			List<Property<?>> props = new ArrayList<>(block.getStateDefinition().getProperties());
			props.sort(Comparator.comparing(Property::getName));
			List<Property<?>> relevant = new ArrayList<>();
			for (Property<?> p : props) {
				Map<String, Integer> groups = new HashMap<>();
				boolean matters = false;
				for (BlockState s : states) {
					StringBuilder k = new StringBuilder();
					for (Property<?> q : props) {
						if (q != p) {
							k.append(valueName(s, q)).append(',');
						}
					}
					Integer g = groups.putIfAbsent(k.toString(), ids.get(s));
					if (g != null && !g.equals(ids.get(s))) {
						matters = true;
						break;
					}
				}
				if (matters) {
					relevant.add(p);
				}
			}
			int size = 1;
			for (Property<?> p : relevant) {
				size *= p.getPossibleValues().size();
			}
			int[] c = new int[size];
			Arrays.fill(c, -1);
			for (BlockState s : states) {
				int idx = 0;
				for (Property<?> p : relevant) {
					idx = idx * p.getPossibleValues().size() + valueIndex(s, p);
				}
				c[idx] = ids.get(s);
			}
			JsonArray pArr = new JsonArray();
			for (Property<?> p : relevant) {
				JsonArray pair = new JsonArray();
				pair.add(p.getName());
				pair.add(values(p));
				pArr.add(pair);
			}
			JsonArray cArr = new JsonArray();
			for (int v : c) {
				cArr.add(v);
			}
			JsonObject b = new JsonObject();
			b.add("p", pArr);
			b.add("c", cArr);
			out.add(name, b);
		}
		JsonObject physics = new JsonObject();
		physics.addProperty("format", PHYSICS_FORMAT);
		physics.add("classes", classes);
		physics.add("blocks", out);
		return physics;
	}

	private static <T extends Comparable<T>> int valueIndex(BlockState state, Property<T> p) {
		return new ArrayList<>(p.getPossibleValues()).indexOf(state.getValue(p));
	}

	private static JsonObject describe(Block block) {
		BlockState def = block.defaultBlockState();
		JsonObject properties = new JsonObject();
		JsonObject defaults = new JsonObject();
		List<Property<?>> props = new ArrayList<>(block.getStateDefinition().getProperties());
		props.sort(Comparator.comparing(Property::getName));
		for (Property<?> p : props) {
			properties.add(p.getName(), values(p));
			defaults.addProperty(p.getName(), valueName(def, p));
		}
		JsonObject info = new JsonObject();
		info.add("properties", properties);
		info.add("default", defaults);
		try {
			int col = def.getMapColor(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).col;
			if (col != 0) {
				info.addProperty("mapColor", String.format("#%06x", col & 0xFFFFFF));
			}
		} catch (RuntimeException ignored) {
			// some modded blocks compute colors from world context
		}
		try {
			info.addProperty("solid", def.isCollisionShapeFullBlock(EmptyBlockGetter.INSTANCE, BlockPos.ZERO));
		} catch (RuntimeException ignored) {
			// shape needs world context
		}
		TreeSet<String> tags = new TreeSet<>();
		BuiltInRegistries.BLOCK.wrapAsHolder(block).tags().forEach(t -> tags.add(t.location().toString()));
		JsonArray tagArray = new JsonArray();
		tags.forEach(tagArray::add);
		info.add("tags", tagArray);
		return info;
	}

	private static <T extends Comparable<T>> JsonArray values(Property<T> p) {
		JsonArray a = new JsonArray();
		for (T v : p.getPossibleValues()) {
			a.add(p.getName(v));
		}
		return a;
	}

	private static <T extends Comparable<T>> String valueName(BlockState state, Property<T> p) {
		return p.getName(state.getValue(p));
	}
}
