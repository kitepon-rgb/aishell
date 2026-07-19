#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const packageMetadata = JSON.parse(
  await readFile(path.join(projectDirectory, "package.json"), "utf8")
);

assert.equal(packageMetadata.name, "@quolu/aishell");
assert.equal(packageMetadata.version, "0.2.1");
assert.deepEqual(packageMetadata.os, ["darwin"]);
assert.deepEqual(packageMetadata.cpu, ["arm64"]);
assert.equal(
  packageMetadata.bin["aishell-mcp"],
  "dist/AIShell.app/Contents/Helpers/aishell-mcp"
);
assert.equal(packageMetadata.bin["aishell-open"], "scripts/aishell-open.mjs");

await access(path.join(projectDirectory, packageMetadata.bin["aishell-mcp"]));

const productMetadataSource = await readFile(
  path.join(projectDirectory, "Sources", "AIShellCore", "FactoryDiagnostics.swift"),
  "utf8"
);
assert.match(
  productMetadataSource,
  new RegExp(`static let version = "${packageMetadata.version.replaceAll(".", "\\.")}"`)
);

const infoPlist = await readFile(
  path.join(projectDirectory, "dist", "AIShell.app", "Contents", "Info.plist"),
  "utf8"
);

assert.match(
  infoPlist,
  new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${packageMetadata.version}</string>`)
);

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "factory_diagnostics", arguments: {} }
  }
];
const mcp = spawnSync(
  path.join(projectDirectory, packageMetadata.bin["aishell-mcp"]),
  [],
  {
    cwd: projectDirectory,
    encoding: "utf8",
    input: `${requests.map(JSON.stringify).join("\n")}\n`
  }
);
assert.equal(mcp.status, 0, mcp.stderr);
const responses = mcp.stdout.trim().split("\n").map(JSON.parse);
const initialize = responses.find((response) => response.id === 1).result;
const tools = responses.find((response) => response.id === 2).result.tools;
const diagnostics = responses.find((response) => response.id === 3).result.structuredContent;
assert.equal(initialize.serverInfo.version, packageMetadata.version);
assert.equal(tools.length, 21);
assert.ok(tools.some((tool) => tool.name === "factory_diagnostics"));
assert.equal(diagnostics.schemaVersion, "aishell.native_factory_diagnostics.v1");
assert.equal(diagnostics.product.version, packageMetadata.version);
assert.equal(diagnostics.ready, true);
assert.deepEqual(diagnostics.issues, []);
const serializedDiagnostics = JSON.stringify(diagnostics);
assert.doesNotMatch(serializedDiagnostics, /\/Users\//);
assert.doesNotMatch(serializedDiagnostics, /allowedRootPaths/);

console.log("npm package metadata and payload are consistent.");
