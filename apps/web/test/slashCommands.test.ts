import assert from "node:assert/strict";
import test from "node:test";
import {
  applySlashCommandSuggestion,
  nextSlashSuggestionIndex,
  slashCommandQuery,
  slashCommandSuggestions
} from "../src/slashCommands.ts";

test("slash command palette appears only while editing the first slash token", () => {
  assert.equal(slashCommandQuery("/g"), "/g");
  assert.equal(slashCommandQuery("  /si"), "/si");
  assert.equal(slashCommandQuery("/goal new target"), null);
  assert.equal(slashCommandQuery("hello /goal"), null);
});

test("slash command suggestions filter and apply stable templates", () => {
  const suggestions = slashCommandSuggestions("/s");
  assert.deepEqual(suggestions.map((item) => item.command), ["/side"]);
  assert.equal(applySlashCommandSuggestion("   /s", suggestions[0]!), "   /side ");
  assert.deepEqual(slashCommandSuggestions("/").map((item) => item.command), ["/goal", "/side", "/help"]);
  assert.equal(applySlashCommandSuggestion("/h", slashCommandSuggestions("/h")[0]!), "/help");
});

test("slash command keyboard navigation wraps", () => {
  assert.equal(nextSlashSuggestionIndex(-1, 1, 3), 0);
  assert.equal(nextSlashSuggestionIndex(0, -1, 3), 2);
  assert.equal(nextSlashSuggestionIndex(2, 1, 3), 0);
});
