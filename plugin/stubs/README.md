# Bukkit stubs

Compile-time-only declarations of the small slice of the Bukkit API the plugin
uses. The real classes come from the server at runtime; these exist so the
plugin can be compiled without the Paper or Spigot artifact, which is not
available on Maven Central.

They are deliberately minimal, and every method here has had the same signature
since Bukkit 1.13. Nothing in this directory ships in the jar.
