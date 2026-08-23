package org.bukkit.entity;
import org.bukkit.Location;
import org.bukkit.command.CommandSender;
public interface Player extends CommandSender {
  Location getLocation();
  String getName();
  void sendMessage(String message);
  boolean hasPermission(String name);
}
