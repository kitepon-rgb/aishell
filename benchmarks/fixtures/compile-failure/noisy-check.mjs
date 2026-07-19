for (let index = 0; index < 4_000; index += 1) {
  console.error(`dependency-scan ${String(index).padStart(4, "0")}: unchanged transitive diagnostic`);
}

try {
  const module = await import("./greeting.mjs");
  if (module.greeting("AIShell") !== "Hello, AIShell!" || module.defaultGreeting !== "Hello, world!") {
    console.error("AssertionError: greeting exports do not match the contract");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}
