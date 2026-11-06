package dev.mcai.item;

import dev.mcai.ui.Msg;
import java.util.List;
import net.fabricmc.fabric.api.creativetab.v1.CreativeModeTabEvents;
import net.minecraft.ChatFormatting;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.item.component.ItemLore;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Rarity;

/** Item registration. */
public final class McaiItems {
	public static final ResourceKey<Item> ARCHITECT_WAND_KEY =
			ResourceKey.create(Registries.ITEM, Identifier.fromNamespaceAndPath("mcai", "architect_wand"));
	public static Item ARCHITECT_WAND;

	private McaiItems() {
	}

	public static void register() {
		ARCHITECT_WAND = Registry.register(BuiltInRegistries.ITEM, ARCHITECT_WAND_KEY,
				new ArchitectWandItem(new Item.Properties().setId(ARCHITECT_WAND_KEY).stacksTo(1).rarity(Rarity.EPIC)
						.component(DataComponents.LORE, new ItemLore(List.of(
								Msg.tr("item.mcai.architect_wand.tooltip1", "Left-click: corner 1 · Right-click: corner 2")
										.withStyle(s -> s.withColor(ChatFormatting.GRAY).withItalic(false)),
								Msg.tr("item.mcai.architect_wand.tooltip2", "/mcai build <prompt> — let the AI build here")
										.withStyle(s -> s.withColor(ChatFormatting.DARK_AQUA).withItalic(false)))))));
		ResourceKey<CreativeModeTab> tools = ResourceKey.create(Registries.CREATIVE_MODE_TAB, Identifier.withDefaultNamespace("tools_and_utilities"));
		CreativeModeTabEvents.modifyOutputEvent(tools).register(output ->
				output.accept(new ItemStack(ARCHITECT_WAND), CreativeModeTab.TabVisibility.PARENT_AND_SEARCH_TABS));
		WandInteractions.register();
	}
}
