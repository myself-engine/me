#!/usr/bin/env bun
// me CLI.
//   me start [config]                      run the kernel
//   me adapt mcp [--yes] <name> -- <command...>    attach an MCP server through the generic bridge
//   me adapt cli [--yes] <name> <commands.json>     expose CLI commands through the generic CLI bridge
//   me adapt market                                 list marketplace recipes
//   me adapt <recipe> [--set k=v ...] [--yes]       install a marketplace recipe (stage 1)
//   me adapt agent <name> -- <what to adapt>        delegate writing an adapter through brgr (stage 3)
//   me adapt export <pluginId> -- <description>     turn an adapted plugin into a recipe
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
    const market = await import("../tools/adapt/market.ts");
    const fail = (err: any) => {
      console.error(`✗ adapt failed: ${err.message}`);
      process.exit(1);
    };
    if (kind === "market") {
      for (const r of await market.listRecipes(root)) console.log(`${r.name.padEnd(14)} ${r.kind.padEnd(4)} ${r.description}`);
      break;
    }
    if (kind === "export") {
      // me adapt export <pluginId> -- <description>
      if (!name || sep !== "--" || !command.length) fail(new Error("usage: me adapt export <pluginId> -- <description>"));
      try {
        const r = await market.exportRecipe(root, name!, command.join(" "));
        console.log(`✓ recipe ${r.recipe.name}: ${r.path}`);
      } catch (err) {
        fail(err);
      }
      break;
    }
    if (kind === "agent") {
      // me adapt agent <name> -- <what to adapt>
      if (!name || sep !== "--" || !command.length) fail(new Error("usage: me adapt agent <name> -- <what to adapt>"));
      try {
        const taskId = await market.agentAdapt(root, name!, command.join(" "));
        console.log(`✓ delegated to a worker through brgr: task ${taskId}`);
        console.log("  review with: brgr diff <task> --stat, then accept and brgr apply");
      } catch (err) {
        fail(err);
      }
      break;
    }
    if (kind && kind !== "mcp" && kind !== "cli") {
      // Stage 1: marketplace recipe. me adapt <recipe> [--set key=value ...] [--yes]
      const set: Record<string, string> = {};
      const extra = args.slice(1);
      for (let i = 0; i < extra.length; i++) {
        if (extra[i] !== "--set" || !extra[i + 1]?.includes("=")) fail(new Error("usage: me adapt <recipe> [--set key=value ...] [--yes]"));
        const [k, ...v] = extra[++i]!.split("=");
        set[k!] = v.join("=");
      }
      try {
        const r = await market.installRecipe(root, kind, { yes, set });
        console.log(`✓ ${r.pluginId}: ${r.detail}`);
        console.log(`  manifest: ${r.manifestPath}`);
        console.log("  registered in me.local.json; restart me to load it");
      } catch (err) {
        fail(err);
      }
      break;
    }
    if (kind === "cli") {
      const { adaptCli } = await import("../tools/adapt/cli.ts");
      if (!name || !sep || command.length) {
        console.error("usage: me adapt cli [--yes] <name> <commands.json>");
        process.exit(1);
      }
      try {
        const r = await adaptCli(root, name, sep, { yes });
        console.log(`✓ ${r.pluginId}: ${r.methods.length} commands (${r.methods.join(", ")})`);
        console.log(`  manifest: ${r.manifestPath}`);
        console.log("  registered in me.local.json; restart me to load it");
      } catch (err: any) {
        console.error(`✗ adapt failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }
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
    console.error("usage: me start [config] | me adapt mcp [--yes] <name> -- <command...> | me adapt cli [--yes] <name> <commands.json> | me doctor [--json]");
    process.exit(cmd ? 1 : 0);
}
