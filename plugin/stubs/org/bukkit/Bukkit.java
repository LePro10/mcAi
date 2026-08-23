package org.bukkit;
import java.util.Collection;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitScheduler;
import org.bukkit.command.ConsoleCommandSender;
public final class Bukkit {
  public static Server getServer() { return null; }
  public static BukkitScheduler getScheduler() { return null; }
  public static java.util.List<World> getWorlds() { return null; }
  public static World getWorld(String name) { return null; }
  public static Player getPlayerExact(String name) { return null; }
  public static Collection<? extends Player> getOnlinePlayers() { return null; }
  public static ConsoleCommandSender getConsoleSender() { return null; }
  public static String getVersion() { return null; }
  public static String getBukkitVersion() { return null; }
  public static void broadcastMessage(String message) {}
}
