import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("fixture remains unchanged", async () => {
  assert.equal(await readFile(new URL("./probe.txt", import.meta.url), "utf8"), "AIShell needle probe\n");
});
