package dev.mcai.world;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.TreeSet;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;

/**
 * Dumps every registered block (vanilla + modded) in the BlockRegistry JSON shape of
 * ARCHITECTURE §3: properties (values in registry order), defaults, map color, tags.
 * Call on the server thread after tags are bound (SERVER_STARTED or later).
 */
public final class RegistryDump {
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
		return registry;
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
