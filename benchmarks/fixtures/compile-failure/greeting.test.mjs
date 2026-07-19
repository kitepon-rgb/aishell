import assert from "node:assert/strict";
import test from "node:test";
import { defaultGreeting, greeting } from "./greeting.mjs";

test("exports intended greetings", () => {
  assert.equal(greeting("AIShell"), "Hello, AIShell!");
  assert.equal(defaultGreeting, "Hello, world!");
});
