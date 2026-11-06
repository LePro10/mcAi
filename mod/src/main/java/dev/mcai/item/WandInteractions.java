package dev.mcai.item;

import dev.mcai.selection.Selections;
import net.fabricmc.fabric.api.event.player.AttackBlockCallback;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;

/** Left-click with the wand sets corner 1 instead of mining. */
public final class WandInteractions {
	private WandInteractions() {
	}

	public static void register() {
		AttackBlockCallback.EVENT.register((player, level, hand, pos, direction) -> {
			if (!player.getItemInHand(hand).is(McaiItems.ARCHITECT_WAND) || player.isSpectator()) {
				return InteractionResult.PASS;
			}
			if (player instanceof ServerPlayer sp) {
				Selections.set(sp, 1, pos);
			}
			return InteractionResult.SUCCESS; // cancels block breaking on both sides
		});
	}
}
