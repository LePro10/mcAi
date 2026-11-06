package dev.mcai.notify;

import com.google.gson.JsonObject;
import dev.mcai.protocol.Json;
import dev.mcai.protocol.ProtocolException;
import java.util.List;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitlesAnimationPacket;
import net.minecraft.network.protocol.game.ClientboundSoundPacket;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;

/** notify: chat / actionbar / title / toast / sound to a player or {@code @a}. Server thread. */
public final class Notifier {
	private final MinecraftServer server;
	private final ChatDecorator decorator;

	public Notifier(MinecraftServer server, ChatDecorator decorator) {
		this.server = server;
		this.decorator = decorator;
	}

	/** @return number of players reached */
	public int notify(JsonObject n) {
		String target = Json.str(n, "target", "@a");
		String kind = Json.str(n, "kind", "chat");
		String sound = Json.str(n, "sound", null);
		Component text = Texts.parse(Json.str(n, "text", ""), server.registryAccess());
		List<ServerPlayer> players = targets(target);
		for (ServerPlayer p : players) {
			switch (kind) {
				case "chat" -> p.sendSystemMessage(decorator.decorate(p, n, text));
				case "actionbar" -> p.sendOverlayMessage(text);
				case "title" -> {
					p.connection.send(new ClientboundSetTitlesAnimationPacket(10, 60, 20));
					String subtitle = Json.str(n, "subtitle", null);
					if (subtitle != null) {
						p.connection.send(new ClientboundSetSubtitleTextPacket(Texts.parse(subtitle, server.registryAccess())));
					}
					p.connection.send(new ClientboundSetTitleTextPacket(text));
				}
				case "toast" -> { // no server-side toasts in vanilla: action bar + toast sound
					p.sendOverlayMessage(text);
					if (sound == null) {
						playSound(p, "minecraft:ui.toast.in");
					}
				}
				case "sound" -> {
					if (sound == null) {
						throw new ProtocolException("notify: kind 'sound' needs 'sound'");
					}
				}
				default -> throw new ProtocolException("notify: unknown kind '" + kind + "'");
			}
			if (sound != null) {
				playSound(p, sound);
			}
		}
		return players.size();
	}

	public List<ServerPlayer> targets(String target) {
		if (target == null || target.isBlank() || target.equals("@a")) {
			return List.copyOf(server.getPlayerList().getPlayers());
		}
		ServerPlayer p = server.getPlayerList().getPlayerByName(target);
		return p == null ? List.of() : List.of(p);
	}

	public static void playSound(ServerPlayer p, String id) {
		Identifier loc = Identifier.tryParse(id);
		if (loc == null) {
			throw new ProtocolException("invalid sound id '" + id + "'");
		}
		Holder<SoundEvent> holder = BuiltInRegistries.SOUND_EVENT.get(loc)
				.<Holder<SoundEvent>>map(h -> h)
				.orElseGet(() -> Holder.direct(SoundEvent.createVariableRangeEvent(loc)));
		p.connection.send(new ClientboundSoundPacket(holder, SoundSource.MASTER, p.getX(), p.getY(), p.getZ(), 1.0f, 1.0f,
				p.getRandom().nextLong()));
	}
}
