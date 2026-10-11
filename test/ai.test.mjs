import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPart, complete } from "../src/main/ai-providers.js";

test("extract the updated part and summary from a model answer", () => {
  const ans = "SUMMARY: Made the plate 8 mm thick.\n```json\n{\"variables\":{\"t\":8},\"features\":[]}\n```";
  const r = extractPart(ans); assert.equal(r.part.variables.t, 8); assert.equal(r.summary, "Made the plate 8 mm thick.");
  const bare = extractPart("Here you go {\"variables\":{},\"features\":[{\"id\":\"a\",\"type\":\"box\"}]} done");
  assert.equal(bare.part.features[0].id, "a");
  const explain = extractPart("This part is a bracket with two holes.");
  assert.equal(explain.part, null); assert.match(explain.summary, /bracket/);
  assert.equal(extractPart("```json\n{bad json\n```").part, null);
});

test("missing key / provider errors are clear", () => {
  assert.throws(() => complete("gemini", {}, "s", "p"), /Add your Google Gemini API key/);
  assert.throws(() => complete("nope", { key: "k" }, "s", "p"), /Unknown AI provider/);
});
