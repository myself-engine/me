#!/usr/bin/env bun
// me CLI.
//   me start [config]                      run the kernel
//   me adapt mcp <name> -- <command...>    attach an MCP server through the generic bridge
import { dirname, join } from "node:path";

const root = join(dirname(import.meta.path), "..");
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "start":
    process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
    await import("../kernel/src/main.ts");
    break;
  case "adapt": {
    const { adaptMcp, usage } = await import("../tools/adapt/adapt.ts");
    const [kind, name, sep, ...command] = rest;
    if (kind !== "mcp" || !name || sep !== "--") {
      console.error(usage());
      process.exit(kind ? 1 : 0);
    }
    try {
      const r = await adaptMcp(root, name!, command);
      console.log(`✓ ${r.pluginId}: ${r.tools.length} tools (${r.tools.join(", ") || "none"})`);
      console.log(`  manifest: ${r.manifestPath}`);
      console.log("  registered in me.local.json; restart me to load it");
    } catch (err: any) {
      console.error(`✗ adapt failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }
  default:
    console.error("usage: me start [config] | me adapt mcp <name> -- <command...>");
    process.exit(cmd ? 1 : 0);
}
