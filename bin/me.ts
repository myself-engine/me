#!/usr/bin/env bun
// me CLI. Full help lives in tools/up/up.ts (helpText); `me help` prints it.
//   me                        bring me up, print the URLs, open the browser
//   me start [config]                      run the kernel
//   me adapt mcp [--yes] <name> -- <command...>    attach an MCP server through the generic bridge
//   me adapt cli [--yes] <name> <commands.json>     expose CLI commands through the generic CLI bridge
//   me adapt market                                 list marketplace recipes
//   me adapt <recipe> [--set k=v ...] [--yes]       install a marketplace recipe (stage 1)
//   me adapt agent <name> -- <what to adapt>        delegate writing an adapter through brgr (stage 3)
//   me adapt export <pluginId> -- <description>     turn an adapted plugin into a recipe
//   me connect <plugin-dir> --host <ip> [--port N]  run a plugin on this machine for a remote kernel
//   me config plan | import [--write] | apply --yes   harness configs (MCP, instructions, skills, hooks) from one source
//   me tailscale status|on|off [--https-port N]   phone access over the tailnet (never public)
//   me doctor [--json]                     tool versions, symlinks, plugin conformance
//   me release [--patch] [--dry-run] [--skip-e2e]   checks, tag, restart the running me, refresh remote copies
//   me autostart install|uninstall|run [--config me.config.json]   start me in a Herdr pane at login
//   me install                             link ~/.local/bin/me so a bare `me` works
//   me help (-h, --help)                   this help, grouped in plain Korean
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(import.meta.path), "..");
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "up": {
    // `me` with no arguments (or flags only, e.g. `me --no-open`): bring me up.
    const args = cmd === undefined ? rest : [cmd, ...rest];
    const noOpen = args.includes("--no-open");
    const at = args.indexOf("--config");
    const config = at >= 0 ? (args[at + 1] ?? "me.config.json") : "me.config.json";
    const { up } = await import("../tools/up/up.ts");
    await up({ root, config, noOpen });
    break;
  }
  case "help":
  case "-h":
  case "--help": {
    const { helpText } = await import("../tools/up/up.ts");
    console.log(helpText());
    break;
  }
  case "install": {
    const { ensureBinLink } = await import("../tools/up/up.ts");
    const r = ensureBinLink(root);
    if (!r.changed) console.log(`이미 연결되어 있어요 (${r.display})`);
    else if (r.onPath) console.log(`✓ me를 PATH에 연결했어요 (${r.display})`);
    else console.log(`✓ ${r.display}를 만들었는데 ~/.local/bin이 PATH에 없어요. 셸 설정에 export PATH="$HOME/.local/bin:$PATH"를 추가하세요.`);
    break;
  }
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
  case "connect": {
    // On a server: me connect <plugin-dir> --host <kernel tailnet ip> [--port 7421] [--token-file f] [--config f.json]
    const { runRemote } = await import("../tools/remote/connect.ts");
    const [pluginDir, ...flags] = rest;
    const opt = (name: string) => {
      const i = flags.indexOf(name);
      return i >= 0 ? flags[i + 1] : undefined;
    };
    const host = opt("--host");
    const port = Number(opt("--port") ?? 7421);
    if (!pluginDir || !host || !Number.isInteger(port)) {
      console.error("usage: me connect <plugin-dir> --host <kernel tailnet ip> [--port 7421] [--id <plugin id>] [--token-file <file>] [--config <file.json>]");
      process.exit(1);
    }
    const configFile = opt("--config");
    const config = configFile ? await Bun.file(configFile).json() : undefined;
    const handle = await runRemote({ pluginDir, host, port, tokenPath: opt("--token-file"), config, id: opt("--id") });
    const stop = async () => {
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await handle.done.catch((err: any) => {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    });
    break;
  }
  case "config": {
    // me config plan | import [--write] | apply --yes   [--harness id ...] [--force]
    const cfg = await import("../tools/config/config.ts");
    const [sub, ...flags] = rest;
    const harnesses = flags.flatMap((f, i) => (f === "--harness" && flags[i + 1] ? [flags[i + 1]!] : []));
    const opts = { harnesses: harnesses.length ? harnesses : undefined, force: flags.includes("--force") };
    try {
      if (sub === "plan") console.log(JSON.stringify(await cfg.configPlan(root, opts), null, 2));
      else if (sub === "import") console.log(JSON.stringify(await cfg.configImport(root, { ...opts, write: flags.includes("--write") }), null, 2));
      else if (sub === "apply") {
        const r = await cfg.configApply(root, { ...opts, yes: flags.includes("--yes") });
        if (!r.applied) {
          console.error(`적용하지 않았어요: ${r.reason}`);
          process.exit(1);
        }
        console.log(`✓ 적용 (${r.approvalId}): ${JSON.stringify(r.files)}`);
      } else {
        console.error("usage: me config plan | import [--write] | apply --yes  [--harness <id> ...] [--force]");
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case "tailscale": {
    // me tailscale status | on | off [--https-port N]   (tailnet only; never funnel)
    const ts = await import("../tools/tailscale/serve.ts");
    const [sub, ...flags] = rest;
    const at = flags.indexOf("--https-port");
    // The web plugin must know the same https port, or tailnet requests are refused as an unknown host.
    const { loadConfig } = await import("../tools/doctor/doctor.ts");
    const webTs = ((await loadConfig(join(root, "me.config.json"))).pluginConfig.web?.tailscale ?? {}) as { enabled?: boolean; httpsPort?: number };
    const httpsPort = at >= 0 ? Number(flags[at + 1]) : (webTs.httpsPort ?? 8443);
    if (!["status", "on", "off"].includes(sub ?? "") || !Number.isInteger(httpsPort)) {
      console.error("usage: me tailscale status | on | off [--https-port 8443]");
      process.exit(1);
    }
    try {
      if (sub === "status") {
        const st = await ts.serveStatus();
        for (const h of st.handlers) console.log(`${h.hostPort}${h.path} → ${h.proxy ?? "?"}`);
        if (!st.handlers.length) console.log("serve: 없음");
        if (st.funnel.length) console.log(`⚠️ funnel(공개) 켜짐: ${st.funnel.join(", ")}`);
      } else if (sub === "on") {
        const r = await ts.serveEnable(ts.DEFAULT_WEB_PORT, { httpsPort });
        console.log(r.changed ? `✓ tailnet에서 https://<기기>:${httpsPort} → 127.0.0.1:${ts.DEFAULT_WEB_PORT}` : "이미 켜져 있어요");
        if (!webTs.enabled) console.log("  ⚠️ me.local.json에 web.tailscale { enabled: true, allowedLogins: [...] }가 있어야 접속이 허용돼요");
        if ((webTs.httpsPort ?? 443) !== httpsPort) {
          console.log(`  ⚠️ web.tailscale.httpsPort가 ${webTs.httpsPort ?? 443}로 되어 있어요. ${httpsPort}로 맞추고 me를 다시 시작해야 접속돼요`);
        }
      } else {
        const r = await ts.serveDisable({ httpsPort });
        console.log(r.changed ? "✓ 껐어요" : "이미 꺼져 있어요");
      }
    } catch (err: any) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case "release": {
    // A release restarts the running me, so anything but the known flags (even --help) only prints usage.
    const RELEASE_FLAGS = ["--patch", "--dry-run", "--skip-e2e"];
    const unknown = rest.filter((a) => !RELEASE_FLAGS.includes(a));
    if (unknown.length) {
      console.log("usage: me release [--patch] [--dry-run] [--skip-e2e]");
      console.log("  checks, bumps the version (minor, or patch), tags, pushes, and restarts the running me");
      if (!unknown.every((a) => a === "--help" || a === "-h")) console.error(`unknown argument: ${unknown.join(" ")}`);
      process.exit(unknown.every((a) => a === "--help" || a === "-h") ? 0 : 2);
    }
    const { release } = await import("../tools/release/release.ts");
    try {
      await release({ root, bump: rest.includes("--patch") ? "patch" : "minor", dryRun: rest.includes("--dry-run"), skipE2e: rest.includes("--skip-e2e") });
    } catch (err: any) {
      console.error(`✗ release failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }
  case "autostart": {
    const a = await import("../tools/autostart/autostart.ts");
    const [action, ...args] = rest;
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const config = flag("--config") ?? "me.config.json";
    if (action === "install") a.install({ root, config });
    else if (action === "uninstall") a.uninstall();
    else if (action === "run") {
      const read = (f: string) => {
        try {
          return JSON.parse(readFileSync(join(root, f), "utf8"));
        } catch {
          return null;
        }
      };
      const port = Number(flag("--port") ?? read("me.local.json")?.pluginConfig?.web?.port ?? read(config)?.pluginConfig?.web?.port ?? 7420);
      try {
        await a.run({ root, config, port });
      } catch (err: any) {
        console.error(`✗ autostart failed: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.log("usage: me autostart install|uninstall|run [--config me.config.json] [--port N]");
      process.exit(action === "--help" || action === "-h" ? 0 : 2);
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
    if (cmd.startsWith("-")) {
      // Flags without a command (e.g. `me --no-open`) mean "just bring me up".
      const args = [cmd, ...rest];
      const noOpen = args.includes("--no-open");
      const at = args.indexOf("--config");
      const config = at >= 0 ? (args[at + 1] ?? "me.config.json") : "me.config.json";
      const { up } = await import("../tools/up/up.ts");
      await up({ root, config, noOpen });
      break;
    }
    {
      const { helpText } = await import("../tools/up/up.ts");
      console.error(`모르는 명령이에요: ${cmd}`);
      console.error(helpText());
    }
    process.exit(1);
}
