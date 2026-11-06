package dev.mcai.gametest.mixin;

import net.minecraft.client.InactivityFpsLimit;
import net.minecraft.client.Options;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Test-only: no vsync, no background frame limit, no pause when the window is in the background. On macOS a buffer swap with vsync can block
 * for as long as the window is hidden behind other windows, which stalls resource loading.
 */
@Mixin(Options.class)
public class TestOptionsMixin {
	@Inject(method = "<init>", at = @At("RETURN"))
	private void mcaiTestDefaults(CallbackInfo ci) {
		Options o = (Options) (Object) this;
		o.enableVsync().set(false);
		o.framerateLimit().set(60);
		o.inactivityFpsLimit().set(InactivityFpsLimit.AFK);
		o.pauseOnLostFocus = false; // the test window is usually in the background

	}
}
