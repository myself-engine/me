#!/usr/bin/env bun
// me CLI. `me start [config]` runs the kernel; more commands (adapt, ...) come later.
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "start":
    process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
    await import("../kernel/src/main.ts");
    break;
  default:
    console.error("usage: me start [config]");
    process.exit(cmd ? 1 : 0);
}
