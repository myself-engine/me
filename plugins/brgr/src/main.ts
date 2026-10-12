// brgr plugin: delegation through brgr's sealed-result contract.
// brgr must run from a Herdr pane with no agent in it; the kernel's own pane qualifies.
// Owner identity is a fixed non-agent session name (config.ownerSession).
// This file only wires ports to adapters; logic lives in domain/ and app/.
import { hostname } from "node:os";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { childEnv } from "@me/env";
import { definePlugin } from "@me/sdk";
import { brgrCli } from "./adapters/brgr-cli.ts";
import { gitCli } from "./adapters/git.ts";
import { KIND, kernelApprovals, kernelBudget, kernelEvents, kernelTaskStore } from "./adapters/kernel.ts";
import { fileSnapshots } from "./adapters/snapshots.ts";
import { fileTrust } from "./adapters/trust.ts";
import { createVerifier, execWithTimeout } from "./adapters/verify.ts";
import { createService } from "./app/service.ts";
import type { BrgrConfig } from "./ports/index.ts";

export type { Task, TaskState } from "./domain/task.ts";

const plugin = definePlugin({
  async onInit() {
    await plugin.entity.registerKind(KIND, { type: "object", required: ["taskId", "state", "harness"] });
    await service.resume();
  },
  methods: {
    "task.delegate": (p) => service.delegate(p),
    "task.result": (p) => service.result(p),
    "task.diff": (p) => service.diff(p),
    "task.accept": (p) => service.accept(p),
    "task.reject": (p) => service.reject(p),
    "task.cancel": (p) => service.cancel(p),
    "task.revert": (p) => service.revert(p),
    "harness.list": () => (plugin.config.harnesses as string[]) ?? ["local.claude-code", "local.codex", "local.gjc", "local.opencode"],
  },
});

const owner = () => (plugin.config.ownerSession as string) ?? `me:${hostname().split(".")[0]}`;

// Verifier children get the allowlist only, plus this plugin's own
// run.envPass when the manifest declares one (read from the manifest file;
// the kernel never sends it, and pluginConfig must not duplicate it).
const manifest = (await Bun.file(new URL("../plugin.json", import.meta.url)).json().catch(() => null)) as {
  run?: { envPass?: unknown };
} | null;
const manifestEnvPass = Array.isArray(manifest?.run?.envPass) ? (manifest.run.envPass as string[]) : [];
const service = createService({
  brgr: brgrCli(owner),
  git: gitCli(),
  store: kernelTaskStore(plugin),
  events: kernelEvents(plugin),
  deadlineSeconds: () => Number(plugin.config.deadlineSeconds ?? 1800),
  config: () => plugin.config as unknown as BrgrConfig,
  verifier: createVerifier({
    exec: (cmd, cwd, timeoutMs) => execWithTimeout(cmd, cwd, timeoutMs, childEnv(manifestEnvPass)),
    readFile: async (path) => readFile(path, "utf8").catch(() => null),
    listDir: (dir) => readdir(dir),
    mkTemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    writeFile: (path, text) => writeFile(path, text),
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    config: () => plugin.config as unknown as BrgrConfig,
  }),
  budget: kernelBudget(plugin),
  approvals: kernelApprovals(plugin),
  trust: fileTrust({
    readText: async (path) => readFile(path, "utf8").catch(() => null),
    writeText: async (path, text) => {
      // Tmp file + rename is atomic; Codex only rewrites this file on
      // explicit config changes, so read-modify-write here is safe.
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.me-tmp-${process.pid}`;
      await writeFile(tmp, text);
      await rename(tmp, path);
    },
    exists: (path) => stat(path).then(() => true, () => false),
  }),
  snapshots: fileSnapshots({
    readText: async (path) => readFile(path, "utf8").catch(() => null),
    listFiles: (root) => listFiles(root),
    fileBytes: async (path) => {
      const st = await lstat(path).catch(() => null);
      // Symlinks could escape the project; only regular files are carried.
      if (!st || !st.isFile()) return null;
      return st.size;
    },
  }),
});

// Recursive file listing for snapshot patterns: skips .git always and
// node_modules unless a literal pattern names it (literals bypass listing).
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  };
  await walk(root);
  return out;
}

await plugin.run();
