package dev.mcai.ui;

/** Hooks the client entrypoint fills in (common code must not reference client classes). */
public final class ClientHooks {
	/** Open the prompt screen (wand right-click into the air on a mod client). */
	public static volatile Runnable openPrompt = null;

	private ClientHooks() {
	}
}
