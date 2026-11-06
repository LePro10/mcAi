package dev.mcai.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcai.bridge.BridgeContext;
import dev.mcai.bridge.RequestHandler;
import dev.mcai.protocol.Json;
import dev.mcai.protocol.ProtocolException;
import dev.mcai.protocol.TypedArrays;
import dev.mcai.world.BlockBox;
import dev.mcai.world.BlockStates;
import dev.mcai.world.ColumnSampleTask;
import dev.mcai.world.Dimensions;
import dev.mcai.world.PlaceBlocksTask;
import dev.mcai.world.ReadBlocksTask;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.levelgen.Heightmap;

/** get_blocks, set_blocks, heightmap, biomes — all run through the tick scheduler (FIFO). */
public final class BlockHandlers {
	public static final long MAX_READ_VOLUME = 1L << 25;      // 33.5M blocks
	public static final int MAX_HEIGHTMAP_COLUMNS = 1 << 22;
	public static final int MAX_BIOME_SAMPLES = 1 << 22;

	private final BridgeContext ctx;

	public BlockHandlers(BridgeContext ctx) {
		this.ctx = ctx;
	}

	public void register(Map<String, RequestHandler> handlers) {
		handlers.put("get_blocks", this::getBlocks);
		handlers.put("set_blocks", this::setBlocks);
		handlers.put("heightmap", this::heightmap);
		handlers.put("biomes", this::biomes);
	}

	private CompletableFuture<JsonObject> getBlocks(JsonObject req) {
		BlockBox box = BlockBox.fromJson(Json.obj(req, "box")).requireVolumeAtMost(MAX_READ_VOLUME);
		boolean withNbt = Json.bool(req, "blockEntities", false);
		return ctx.onServer(() -> {
			ServerLevel level = Dimensions.level(ctx.server(), Json.str(req, "dimension", null));
			ReadBlocksTask task = new ReadBlocksTask(level, box, withNbt);
			ctx.scheduler().submit(task);
			return task.future();
		}).thenCompose(f -> f).thenApplyAsync(r -> {
			JsonObject out = new JsonObject();
			out.add("palette", Json.strings(r.palette()));
			out.addProperty("data", TypedArrays.encodeUint16(r.data()));
			return out;
		}, ctx.workers());
	}

	private CompletableFuture<JsonObject> setBlocks(JsonObject req) {
		String[] paletteStrings = Json.strings(req, "palette");
		int[] positions = TypedArrays.decodeInt32(Json.str(req, "positions", ""), "positions");
		char[] states = TypedArrays.decodeUint16(Json.str(req, "states", ""), "states");
		if (positions.length != states.length * 3) {
			throw new ProtocolException("set_blocks: " + states.length + " states but " + positions.length / 3.0 + " positions");
		}
		if (states.length > PlaceBlocksTask.MAX_BLOCKS) {
			throw new ProtocolException("set_blocks: at most " + PlaceBlocksTask.MAX_BLOCKS + " blocks per message");
		}
		boolean updateShapes = Json.bool(req, "updateShapes", true);
		String animate = Json.str(req, "animate", "none");
		int maxPerTick = Json.integer(req, "maxPerTick", ctx.config().maxPerTick);
		// The block registry is frozen: parsing is safe off the server thread.
		BlockStates.Parsed[] palette = BlockStates.parseAll(BuiltInRegistries.BLOCK, paletteStrings);
		return ctx.onServer(() -> {
			ServerLevel level = Dimensions.level(ctx.server(), Json.str(req, "dimension", null));
			PlaceBlocksTask task = new PlaceBlocksTask(level, palette, positions, states, updateShapes, animate, maxPerTick);
			ctx.scheduler().submit(task);
			return task.future();
		}).thenCompose(f -> f).thenApplyAsync(BlockHandlers::placeResult, ctx.workers());
	}

	private static JsonObject placeResult(PlaceBlocksTask.Result r) {
		JsonObject out = new JsonObject();
		out.addProperty("placed", r.placed());
		out.addProperty("unchanged", r.unchanged());
		JsonArray failed = new JsonArray();
		for (PlaceBlocksTask.Failure f : r.failed()) {
			JsonObject o = new JsonObject();
			o.addProperty("index", f.index());
			o.addProperty("reason", f.reason());
			failed.add(o);
		}
		out.add("failed", failed);
		JsonObject previous = new JsonObject();
		previous.add("palette", Json.strings(r.previousPalette()));
		previous.addProperty("states", TypedArrays.encodeUint16(r.previousStates()));
		out.add("previous", previous);
		out.addProperty("shapeUpdates", r.shapeUpdates());
		out.addProperty("ticks", r.ticks());
		out.addProperty("ms", r.nanos() / 1_000_000.0);
		out.addProperty("placeMs", r.placeNanos() / 1_000_000.0);
		out.addProperty("shapeMs", r.shapeNanos() / 1_000_000.0);
		return out;
	}

	private CompletableFuture<JsonObject> heightmap(JsonObject req) {
		int ax = Json.requireInt(req, "x0"), az = Json.requireInt(req, "z0");
		int bx = Json.requireInt(req, "x1"), bz = Json.requireInt(req, "z1");
		int x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), z0 = Math.min(az, bz), z1 = Math.max(az, bz);
		long columns = (long) (x1 - x0 + 1) * (z1 - z0 + 1);
		if (columns > MAX_HEIGHTMAP_COLUMNS) {
			throw new ProtocolException("heightmap: " + columns + " columns exceeds " + MAX_HEIGHTMAP_COLUMNS);
		}
		Heightmap.Types type = switch (Json.str(req, "kind", "surface")) {
			case "surface" -> Heightmap.Types.WORLD_SURFACE;
			case "ocean_floor" -> Heightmap.Types.OCEAN_FLOOR;
			default -> throw new ProtocolException("heightmap: kind must be 'surface' or 'ocean_floor'");
		};
		int sx = x1 - x0 + 1;
		short[] data = new short[(int) columns];
		return ctx.onServer(() -> {
			ServerLevel level = Dimensions.level(ctx.server(), Json.str(req, "dimension", null));
			// Y of the highest non-air block
			ColumnSampleTask<short[]> task = new ColumnSampleTask<>(data.length,
					i -> {
						int x = x0 + i % sx, z = z0 + i / sx;
						// load the chunk (Level#getHeight answers minY for unloaded chunks); the chunk
						// heightmap API returns the Y of the highest non-air block directly
						data[i] = (short) level.getChunk(x >> 4, z >> 4).getHeight(type, x & 15, z & 15);
					}, () -> data);
			ctx.scheduler().submit(task);
			return task.future();
		}).thenCompose(f -> f).thenApplyAsync(d -> {
			JsonObject out = new JsonObject();
			out.addProperty("x0", x0);
			out.addProperty("z0", z0);
			out.addProperty("x1", x1);
			out.addProperty("z1", z1);
			out.addProperty("data", TypedArrays.encodeInt16(d));
			return out;
		}, ctx.workers());
	}

	private CompletableFuture<JsonObject> biomes(JsonObject req) {
		BlockBox box = BlockBox.fromJson(Json.obj(req, "box"));
		int step = Math.max(1, Json.integer(req, "step", 4));
		int nx = (box.sizeX() - 1) / step + 1, ny = (box.sizeY() - 1) / step + 1, nz = (box.sizeZ() - 1) / step + 1;
		long count = (long) nx * ny * nz;
		if (count > MAX_BIOME_SAMPLES) {
			throw new ProtocolException("biomes: " + count + " samples exceeds " + MAX_BIOME_SAMPLES + " (increase step)");
		}
		char[] data = new char[(int) count];
		List<String> palette = new ArrayList<>();
		Map<Holder<Biome>, Character> index = new HashMap<>();
		BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
		return ctx.onServer(() -> {
			ServerLevel level = Dimensions.level(ctx.server(), Json.str(req, "dimension", null));
			ColumnSampleTask<char[]> task = new ColumnSampleTask<>(data.length, i -> {
				int x = i % nx, z = (i / nx) % nz, y = i / (nx * nz);
				Holder<Biome> b = level.getBiome(pos.set(box.minX() + x * step, box.minY() + y * step, box.minZ() + z * step));
				data[i] = index.computeIfAbsent(b, h -> {
					palette.add(h.unwrapKey().map(k -> k.identifier().toString()).orElse("minecraft:plains"));
					return (char) (palette.size() - 1);
				});
			}, () -> data);
			ctx.scheduler().submit(task);
			return task.future();
		}).thenCompose(f -> f).thenApplyAsync(d -> {
			JsonObject out = new JsonObject();
			out.add("palette", Json.strings(palette));
			out.addProperty("data", TypedArrays.encodeUint16(d));
			out.addProperty("step", step);
			out.add("size", Json.array(nx, ny, nz));
			return out;
		}, ctx.workers());
	}
}
