package dev.mcai.plugin;

/**
 * Tests for the hand-rolled JSON in the plugin.
 *
 * The plugin cannot depend on a JSON library — a Bukkit plugin ships what it
 * brings, and 200 lines beats a 300 KB shaded jar. But hand-rolled parsing is
 * exactly where a plugin silently corrupts a player's prompt, so the cases
 * that matter are pinned here: quoting, escapes, keys that also occur as
 * values, and numbers that are not strings.
 *
 * Run with plugin/test.sh.
 */
public final class JsonTest {

  private static int failures;

  public static void main(String[] args) {
    quotesEscapeCorrectly();
    controlCharactersEscapeAsUnicode();
    fieldsReadBack();
    aKeyIsNotConfusedWithAValue();
    missingFieldsAreNull();
    nestedFieldsRead();
    numbersAndBooleansRead();
    roundTripsAPrompt();
    commandArraysParse();
    coordinateArraysParse();

    if (failures > 0) {
      System.out.println(failures + " failed");
      System.exit(1);
    }
    System.out.println("Json: all tests passed");
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  private static void quotesEscapeCorrectly() {
    eq("\"a\\\"b\"", Json.string("a\"b"), "a quote is escaped");
    eq("\"a\\\\b\"", Json.string("a\\b"), "a backslash is escaped");
    eq("\"a\\nb\"", Json.string("a\nb"), "a newline is escaped");
    eq("\"a\\tb\"", Json.string("a\tb"), "a tab is escaped");
    eq("\"\"", Json.string(""), "the empty string");
    eq("null", Json.string(null), "null writes the JSON null, not a quoted one");
  }

  private static void controlCharactersEscapeAsUnicode() {
    // A raw control character in a JSON string is invalid, and Node's parser
    // rejects the whole request — which would look like "the engine ignored
    // me" to the player who typed it.
    String withControl = "a" + ((char) 1) + "b";
    eq("\"a\\u0001b\"", Json.string(withControl), "a control character becomes \\u0001");

    String withDelete = "x" + ((char) 0x1f) + "y";
    eq("\"x\\u001fy\"", Json.string(withDelete), "0x1f becomes \\u001f");
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  private static void fieldsReadBack() {
    String body = "{\"error\":\"no model configured\",\"blocks\":1234}";
    eq("no model configured", Json.field(body, "error"), "a string field");
    eq("1234", Json.field(body, "blocks"), "a number field comes back as text");
  }

  private static void aKeyIsNotConfusedWithAValue() {
    // The naive indexOf("\"error\"") would find the *value* here and read the
    // wrong side of the colon.
    String body = "{\"label\":\"error\",\"error\":\"the real one\"}";
    eq("the real one", Json.field(body, "error"), "the key wins over an identical value");
    eq("error", Json.field(body, "label"), "and the value still reads");
  }

  private static void missingFieldsAreNull() {
    eq(null, Json.field("{\"a\":1}", "b"), "a missing field is null");
    eq(null, Json.field("", "a"), "an empty body is null");
    eq(null, Json.field(null, "a"), "a null body is null");
  }

  private static void nestedFieldsRead() {
    String body = "{\"llm\":{\"provider\":\"anthropic\",\"model\":\"claude-sonnet-5\"},\"ok\":true}";
    eq("claude-sonnet-5", Json.nested(body, "llm", "model"), "a nested field");
    eq(null, Json.nested(body, "llm", "missing"), "a missing nested field");
    eq(null, Json.nested(body, "missing", "model"), "a missing nested object");
  }

  private static void numbersAndBooleansRead() {
    String body = "{\"ok\":true,\"count\":0,\"ratio\":8.4,\"name\":null}";
    eq("true", Json.field(body, "ok"), "a boolean");
    eq("0", Json.field(body, "count"), "zero");
    eq("8.4", Json.field(body, "ratio"), "a decimal");
    eq(null, Json.field(body, "name"), "a JSON null reads as absent");
  }

  private static void roundTripsAPrompt() {
    // What a player actually types, quotes and all.
    String prompt = "a \"huge\" castle\\keep on the hill";
    String body = "{\"prompt\":" + Json.string(prompt) + "}";
    eq(prompt, Json.field(body, "prompt"), "a prompt survives the round trip");
  }

  /**
   * The batch the engine posts to /exec. Getting this wrong drops or mangles
   * commands in the middle of a build, which is the worst failure the plugin
   * has: half a castle, and no clean undo.
   */
  private static void commandArraysParse() {
    String body = "{\"commands\":[\"fill 0 64 0 4 68 4 stone\","
        + "\"setblock 1 65 1 oak_door[facing=north,half=lower]\"]}";
    java.util.List<String> commands = Json.stringArray(body, "commands");
    eq("2", String.valueOf(commands.size()), "two commands");
    eq("fill 0 64 0 4 68 4 stone", commands.get(0), "the first command");
    eq("setblock 1 65 1 oak_door[facing=north,half=lower]",
        commands.get(1), "block states survive the brackets");

    java.util.List<String> empty = Json.stringArray("{\"commands\":[]}", "commands");
    eq("0", String.valueOf(empty.size()), "an empty batch");

    // A command containing a quote or a comma must not split the array.
    java.util.List<String> tricky = Json.stringArray(
        "{\"commands\":[\"say \\\"hi, there\\\"\",\"say two\"]}", "commands");
    eq("2", String.valueOf(tricky.size()), "quotes and commas do not split commands");
    eq("say \"hi, there\"", tricky.get(0), "the quoted command reads back whole");
  }

  private static void coordinateArraysParse() {
    String body = "{\"min\":[-12,60,-12],\"max\":[12,90,12]}";
    int[] min = Json.intArray(body, "min");
    int[] max = Json.intArray(body, "max");
    eq("-12,60,-12", join(min), "negative coordinates");
    eq("12,90,12", join(max), "positive coordinates");
    eq("", join(Json.intArray("{\"min\":[]}", "min")), "an empty array");
    eq(null, join(Json.intArray("{\"a\":1}", "min")), "a missing array is null");
  }

  private static String join(int[] values) {
    if (values == null) return null;
    StringBuilder sb = new StringBuilder();
    for (int v : values) {
      if (sb.length() > 0) sb.append(',');
      sb.append(v);
    }
    return sb.toString();
  }

  // ── Harness ──────────────────────────────────────────────────────────────

  private static void eq(String expected, String actual, String what) {
    boolean same = expected == null ? actual == null : expected.equals(actual);
    if (same) return;
    failures++;
    System.out.println("FAIL " + what);
    System.out.println("  expected " + expected);
    System.out.println("  actual   " + actual);
  }
}
