package org.bukkit.scheduler;
import java.util.concurrent.Callable;
import java.util.concurrent.Future;
import org.bukkit.plugin.java.JavaPlugin;
public interface BukkitScheduler {
  <T> Future<T> callSyncMethod(JavaPlugin plugin, Callable<T> task);
  void runTask(JavaPlugin plugin, Runnable task);
  void runTaskAsynchronously(JavaPlugin plugin, Runnable task);
}
