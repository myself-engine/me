import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentAdapt, agentBrief, exportRecipe, fillCommand, findRecipe, installRecipe, listRecipes, type Recipe } from "./market.ts";

const repo = join(import.meta.dir, "..", "..");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "me-market-"));
  symlinkSync(join(repo, "bridges"), join(root, "bridges"));
  mkdirSync(join(root, "marketplace"), { recursive: true });
  cpSync(join(repo, "marketplace", "recipes"), join(root, "marketplace", "recipes"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the shipped recipes are well-formed", async () => {
  const recipes = await listRecipes(repo);
  expect(recipes.map((r) => r.name)).toEqual(["filesystem", "git", "github"]);
  for (const r of recipes) {
    expect(r.description.length).toBeGreaterThan(0);
    if (r.kind === "mcp") expect(r.command.length).toBeGreaterThan(0);
    else expect(Object.keys(r.commands).length).toBeGreaterThan(0);
  }
});

test("fillCommand substitutes declared params and rejects unknown or missing ones", () => {
  const r: Extract<Recipe, { kind: "mcp" }> = { name: "x", kind: "mcp", description: "d", command: ["srv", "{dir}"], params: { dir: { required: true } } };
  expect(fillCommand(r, { dir: "/tmp/a b" })).toEqual(["srv", "/tmp/a b"]);
  expect(() => fillCommand(r, {})).toThrow("missing --set dir");
  expect(() => fillCommand(r, { dir: "/x", evil: "1" })).toThrow("unknown param");
});

test("installRecipe installs a CLI recipe through the CLI bridge", async () => {
  const r = await installRecipe(root, "git", { yes: true, print: () => {} });
  expect(r.pluginId).toBe("cli-git");
  expect(r.detail).toContain("status");
  const local = await Bun.file(join(root, "me.local.json")).json();
  expect(local.extraPlugins).toContain("plugins/cli-git");
});

test("installRecipe refuses unknown recipes and invalid names", async () => {
  await expect(installRecipe(root, "nope", { yes: true })).rejects.toThrow("no marketplace recipe");
  expect(await findRecipe(root, "../etc")).toBeNull();
});

test("an installed adapter can be exported back as a recipe", async () => {
  await installRecipe(root, "git", { yes: true, print: () => {} });
  rmSync(join(root, "marketplace", "recipes", "git.json"));
  const { recipe } = await exportRecipe(root, "cli-git", "git again");
  expect(recipe).toMatchObject({ name: "git", kind: "cli", description: "git again" });
  expect(Object.keys((recipe as any).commands)).toContain("log");
});

test("export never carries env values", async () => {
  await Bun.write(
    join(root, "me.local.json"),
    JSON.stringify({ pluginConfig: { "mcp-secret": { server: { command: "srv", args: ["--x"], env: { TOKEN: "s3cr3t" } } } } }),
  );
  const { path } = await exportRecipe(root, "mcp-secret", "d");
  expect(await Bun.file(path).text()).not.toContain("s3cr3t");
});

test("agentAdapt delegates through brgr with a conformance criterion", async () => {
  let seen: string[] = [];
  const id = await agentAdapt(root, "weather", "a weather API at https://example.com", {
    run: async (argv) => ((seen = argv), { code: 0, stdout: JSON.stringify({ task_id: "t-1" }), stderr: "" }),
  });
  expect(id).toBe("t-1");
  expect(seen.slice(0, 2)).toEqual(["brgr", "run"]);
  expect(seen).toContain("--capture-diff");
  expect(seen.join(" ")).toContain("spec/conformance/run.ts plugins/weather");
  expect(agentBrief("weather", "x")).toContain("If a generic bridge");
});
