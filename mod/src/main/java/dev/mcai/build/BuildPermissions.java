package dev.mcai.build;

import dev.mcai.config.McaiConfig;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/** Who may start AI builds and use /mcai: permission level ≥ config, or the singleplayer owner. */
public final class BuildPermissions {
	private BuildPermissions() {
	}

	public static boolean canBuild(ServerPlayer player, McaiConfig cfg) {
		MinecraftServer server = player.level().getServer();
		if (server.isSingleplayerOwner(player.nameAndId())) {
			return true;
		}
		return server.getProfilePermissions(player.nameAndId()).level().ordinal() >= cfg.buildPermissionLevel;
	}
}
