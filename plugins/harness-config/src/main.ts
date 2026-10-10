// harness-config plugin: one source of MCP servers and instruction fragments, rendered into each
// coding harness's own config file (DECISIONS §15 설정 통합 관리).
//
// Writing harness config files (~/.claude.json, ~/.codex/config.toml, opencode.json, GJC mcp.json,
// AGENTS.md/CLAUDE.md) is this plugin's whole purpose. The kernel has no file-write permission, so
// the manifest asks only for read-state and emit; there is no shell and no network access.
// Writes are gated instead: `apply` needs the planId of a fresh `plan` and an approvalId the caller
// got from kernel approval, and every file is backed up next to itself before it is replaced.
//
// Config: sourcePath (default $ME_HOME/harness-config/source.json), projectDir (enables Claude Code's
// project .mcp.json). This file only wires ports to adapters; logic lives in domain/ and app/.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { definePlugin } from "@me/sdk";
import { composeService } from "./adapters/compose.ts";
import { kernelEvents } from "./adapters/kernel.ts";
import type { Service } from "./app/service.ts";

let service: Service;

const plugin = definePlugin({
  onInit(info) {
    const meHome =
      process.env.ME_HOME ?? (process.env.ME_DATA_DIR ? resolve(process.env.ME_DATA_DIR, "..", "..") : join(homedir(), ".me"));
    service = composeService({
      home: homedir(),
      meHome,
      sourcePath: typeof info.config.sourcePath === "string" ? info.config.sourcePath : undefined,
      projectDir: typeof info.config.projectDir === "string" ? info.config.projectDir : undefined,
      env: process.env,
      events: kernelEvents(plugin),
    });
  },
  methods: {
    plan: (p) => service.plan(p ?? {}),
    apply: (p) => service.apply(p ?? {}),
    import: (p) => service.import(p ?? {}),
    list: () => service.list(),
  },
});

await plugin.run();
