package dev.mcai.item;

import dev.mcai.selection.Selection;
import dev.mcai.selection.Selections;
import dev.mcai.net.ServerNetworking;
import dev.mcai.ui.ClientHooks;
import dev.mcai.ui.Msg;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The Architect's Wand: left-click a block = corner 1, right-click a block = corner 2
 * (like WorldEdit), right-click into the air = selection summary / how to start a build.
 * Left-click handling lives in {@link WandInteractions} (attack callback).
 */
public final class ArchitectWandItem extends Item {
	public ArchitectWandItem(Properties properties) {
		super(properties);
	}

	@Override
	public InteractionResult useOn(UseOnContext ctx) {
		if (ctx.getPlayer() instanceof ServerPlayer player) {
			Selections.set(player, 2, ctx.getClickedPos());
		}
		return InteractionResult.SUCCESS;
	}

	@Override
	public InteractionResult use(Level level, Player player, InteractionHand hand) {
		if (level.isClientSide()) {
			Runnable open = ClientHooks.openPrompt;
			if (open != null) {
				open.run(); // mod client: the prompt GUI
			}
		} else if (player instanceof ServerPlayer sp && !ServerNetworking.hasMod(sp)) {
			// vanilla client: explain in chat
			Selection sel = Selections.get(sp);
			if (sel != null && sel.complete()) {
				BlockPos a = sel.min();
				BlockPos b = sel.max();
				sp.sendSystemMessage(Msg.prefixed(Msg.tr("mcai.wand.summary", "Selection %s → %s (%s × %s × %s). Describe your build with /mcai build <prompt>",
						a.toShortString(), b.toShortString(), sel.sizeX(), sel.sizeY(), sel.sizeZ())));
			} else {
				sp.sendSystemMessage(Msg.prefixed(Msg.tr("mcai.wand.help", "Left-click a block for corner 1, right-click a block for corner 2, then /mcai build <prompt>")));
			}
		}
		return InteractionResult.SUCCESS;
	}

	@Override
	public boolean canDestroyBlock(ItemStack stack, BlockState state, Level level, BlockPos pos, LivingEntity entity) {
		return false; // the wand selects, it never breaks blocks (also in creative)
	}

	@Override
	public boolean isFoil(ItemStack stack) {
		return true;
	}
}
