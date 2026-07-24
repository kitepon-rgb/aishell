#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const packageMetadata = JSON.parse(
  await readFile(path.join(projectDirectory, "package.json"), "utf8")
);

assert.equal(packageMetadata.name, "@quolu/aishell");
assert.equal(packageMetadata.version, "0.3.6");
assert.deepEqual(packageMetadata.os, ["darwin"]);
assert.deepEqual(packageMetadata.cpu, ["arm64"]);
assert.equal(
  packageMetadata.bin["aishell-mcp"],
  "dist/AIShell.app/Contents/Helpers/aishell-mcp"
);
assert.equal(packageMetadata.bin["aishell-open"], "scripts/aishell-open.mjs");

await access(path.join(projectDirectory, packageMetadata.bin["aishell-mcp"]));

const infoPlist = await readFile(
  path.join(projectDirectory, "dist", "AIShell.app", "Contents", "Info.plist"),
  "utf8"
);

assert.match(
  infoPlist,
  new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${packageMetadata.version}</string>`)
);
assert.match(
  infoPlist,
  /<key>CFBundleVersion<\/key>\s*<string>10<\/string>/
);

console.log("npm package metadata and payload are consistent.");
