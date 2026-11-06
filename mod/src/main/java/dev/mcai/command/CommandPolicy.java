package dev.mcai.command;

import dev.mcai.config.McaiConfig;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Defense-in-depth mirror of the engine's command allowlist (ARCHITECTURE §9,
 * engine/src/server/commands.ts). The engine is the primary gate; the mod re-checks the verb,
 * selectors and forbidden content. Region checks stay in the engine (it knows the job box).
 */
public final class CommandPolicy {
	static final Set<String> DECORATIVE_ENTITIES = Set.of(
			"armor_stand", "item_frame", "glow_item_frame", "painting", "block_display", "item_display", "text_display", "interaction",
			"villager", "wandering_trader", "cat", "wolf", "horse", "donkey", "mule", "llama", "camel", "sheep", "cow", "mooshroom",
			"pig", "chicken", "rabbit", "fox", "parrot", "bee", "goat", "frog", "axolotl", "turtle", "panda", "polar_bear", "ocelot",
			"iron_golem", "snow_golem", "allay", "tropical_fish", "cod", "salmon", "dolphin", "squid", "glow_squid", "sniffer",
			"armadillo", "happy_ghast", "copper_golem", "leash_knot", "minecart", "oak_boat", "spruce_boat", "birch_boat", "cherry_boat",
			"bamboo_raft", "pale_oak_boat", "mangrove_boat", "acacia_boat", "jungle_boat", "dark_oak_boat", "end_crystal");

	private static final Pattern FORBIDDEN = Pattern.compile(
			"\\b(op|deop|stop|ban|ban-ip|pardon|kick|whitelist|execute|give|kill|tp|teleport|gamemode|gamerule|difficulty|function|reload"
					+ "|save-all|save-off|data\\s+modify\\s+storage|scoreboard|forceload|setworldspawn|spawnpoint|clear|enchant|effect|xp|experience"
					+ "|summon\\s+\\S*(tnt|wither|ender_dragon|lightning|warden|creeper|fireball))\\b",
			Pattern.CASE_INSENSITIVE);
	private static final Pattern WIDE_SELECTOR = Pattern.compile("@[aer]\\b|@[aer]\\[");
	private static final Pattern COMMANDS_IN_DATA = Pattern.compile("command_block|\"run_command\"|run_command", Pattern.CASE_INSENSITIVE);
	/** {@code id:"minecraft:tnt"} / {@code id:'tnt'} / {@code id:creeper} inside entity data (Passengers, …). */
	private static final Pattern DATA_ID = Pattern.compile("\\bid\\s*:\\s*[\"']?(?:minecraft:)?([a-z0-9_./-]+)", Pattern.CASE_INSENSITIVE);

	private final boolean allowTimeWeather;
	private final List<String> extra;

	public CommandPolicy(McaiConfig config, List<String> engineExtras) {
		this.allowTimeWeather = config.allowTimeWeather;
		this.extra = java.util.stream.Stream.concat(config.commandAllowlist.stream(), engineExtras.stream())
				.map(s -> s.trim().toLowerCase(Locale.ROOT)).filter(s -> !s.isEmpty()).toList();
	}

	/**
	 * First entity id in the command's data that is a registered entity type but not decorative
	 * (an armor stand with a TNT/wither passenger), else null. Item ids that are no entity types
	 * (item frame contents, equipment) are fine.
	 */
	static String nonDecorativeEntityInData(String command) {
		java.util.regex.Matcher m = DATA_ID.matcher(command);
		while (m.find()) {
			String id = m.group(1).toLowerCase(Locale.ROOT);
			net.minecraft.resources.Identifier key = net.minecraft.resources.Identifier.tryParse("minecraft:" + id);
			if (key != null && !DECORATIVE_ENTITIES.contains(id) && net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.containsKey(key)) {
				return id;
			}
		}
		return null;
	}

	/** @return null if allowed, else the reason it was rejected */
	public String check(String command) {
		String c = command == null ? "" : command.trim();
		if (c.startsWith("/")) {
			c = c.substring(1);
		}
		if (c.isEmpty()) {
			return "empty command";
		}
		if (c.indexOf('\n') >= 0 || c.indexOf('\r') >= 0) {
			return "one command per call (no newlines)";
		}
		String lower = c.toLowerCase(Locale.ROOT);
		String[] tokens = lower.split("\\s+");
		String verb = tokens[0].startsWith("minecraft:") ? tokens[0].substring(10) : tokens[0];
		for (String e : extra) {
			if (lower.startsWith(e) && !lower.matches("(?s).*\\b(execute|op)\\b.*")) {
				return null;
			}
		}
		if (WIDE_SELECTOR.matcher(c).find()) {
			return "selectors other than @s/@p are not allowed";
		}
		switch (verb) {
			case "summon" -> {
				String entity = tokens.length > 1 ? tokens[1].replaceFirst("^minecraft:", "") : "";
				if (!DECORATIVE_ENTITIES.contains(entity)) {
					return "summon '" + entity + "' is not allowed (decorative entities only)";
				}
				if (COMMANDS_IN_DATA.matcher(c).find()) {
					return "entity data with commands is not allowed";
				}
				String nested = nonDecorativeEntityInData(c);
				if (nested != null) {
					return "entity data contains the non-decorative entity '" + nested + "' (e.g. as a passenger)";
				}
				String rest = String.join(" ", java.util.Arrays.copyOfRange(tokens, Math.min(5, tokens.length), tokens.length))
						.replaceAll("(?s)\\{.*}", "");
				return FORBIDDEN.matcher(rest).find() ? "forbidden content in summon arguments" : null;
			}
			case "fillbiome" -> {
				return null;
			}
			case "particle", "playsound" -> {
				return FORBIDDEN.matcher(lower.substring(tokens[0].length())).find() ? "forbidden content" : null;
			}
			case "time", "weather" -> {
				return allowTimeWeather ? null : verb + " is disabled (allowTimeWeather in config/mcai.json)";
			}
			default -> {
				return "command '" + verb + "' is not allowed by the mcai mod (allowed: summon <decorative>, fillbiome, particle, playsound)";
			}
		}
	}
}
