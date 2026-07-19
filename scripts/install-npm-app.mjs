#!/usr/bin/env node

import { access, mkdir, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.npm_config_global !== "true") {
  console.log("AIShell.app installation skipped because this is not a global npm install.");
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.dirname(scriptDirectory);
const sourceApp = path.join(packageDirectory, "dist", "AIShell.app");
const applicationsDirectory = process.env.AISHELL_APPLICATIONS_DIR
  ? path.resolve(process.env.AISHELL_APPLICATIONS_DIR)
  : path.join(os.homedir(), "Applications");
const targetApp = path.join(applicationsDirectory, "AIShell.app");
const temporaryApp = path.join(applicationsDirectory, `.AIShell.installing-${process.pid}.app`);
const previousApp = path.join(applicationsDirectory, "AIShell.previous.app");

await access(sourceApp);
await mkdir(applicationsDirectory, { recursive: true });
await rm(temporaryApp, { recursive: true, force: true });

const copy = spawnSync("/usr/bin/ditto", [sourceApp, temporaryApp], {
  stdio: "inherit"
});

if (copy.error) {
  throw copy.error;
}

if (copy.status !== 0) {
  throw new Error(`AIShell.app copy failed with status ${copy.status}`);
}

let hadPreviousInstallation = false;

try {
  await access(targetApp);
  hadPreviousInstallation = true;
} catch {
  hadPreviousInstallation = false;
}

if (hadPreviousInstallation) {
  await rm(previousApp, { recursive: true, force: true });
  await rename(targetApp, previousApp);
}

try {
  await rename(temporaryApp, targetApp);
} catch (error) {
  if (hadPreviousInstallation) {
    await rename(previousApp, targetApp);
  }
  throw error;
}

console.log(`Installed AIShell.app at ${targetApp}`);
