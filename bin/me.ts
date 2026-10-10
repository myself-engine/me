#!/usr/bin/env bun
// me CLI.
//   me start [config]                      run the kernel
//   me adapt mcp [--yes] <name> -- <command...>    attach an MCP server through the generic bridge
//   me doctor [--json]                     tool versions, symlinks, plugin conformance
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
    // --yes is only an adapt flag before the `--`; everything after belongs to the MCP server command.
    const sepAt = rest.indexOf("--");
    const head = sepAt < 0 ? rest : rest.slice(0, sepAt);
    const yes = head.includes("--yes") || head.includes("-y");
    const args = [...head.filter((a) => a !== "--yes" && a !== "-y"), ...(sepAt < 0 ? [] : rest.slice(sepAt))];
    const [kind, name, sep, ...command] = args;
    if (kind !== "mcp" || !name || sep !== "--") {
      console.error(usage());
      process.exit(kind ? 1 : 0);
    }
    try {
      const r = await adaptMcp(root, name!, command, { yes });
      console.log(`✓ ${r.pluginId}: ${r.tools.length} tools (${r.tools.join(", ") || "none"})`);
      console.log(`  manifest: ${r.manifestPath}`);
      console.log("  registered in me.local.json; restart me to load it");
    } catch (err: any) {
      console.error(`✗ adapt failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case "doctor": {
    const { runDoctor, formatReport } = await import("../tools/doctor/doctor.ts");
    const json = rest.includes("--json");
    const unknown = rest.filter((a) => a !== "--json");
    if (unknown.length) {
      console.error("usage: me doctor [--json]");
      process.exit(1);
    }
    const report = await runDoctor(root, { log: json ? undefined : (s) => console.error(`… ${s}`) });
    console.log(json ? JSON.stringify(report, null, 2) : formatReport(report, root));
    process.exit(report.ok ? 0 : 1);
  }
  default:
    console.error("usage: me start [config] | me adapt mcp [--yes] <name> -- <command...> | me doctor [--json]");
    process.exit(cmd ? 1 : 0);
}
