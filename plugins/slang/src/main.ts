import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { definePlugin } from "@myself/sdk";
import { DEFAULT_DICT, normalize, type SlangEntry } from "./dict.ts";

const dataDir = process.env.MYSELF_DATA_DIR ?? ".";
mkdirSync(dataDir, { recursive: true });
const userDictPath = join(dataDir, "user-dict.json");

async function userDict(): Promise<SlangEntry[]> {
  const f = Bun.file(userDictPath);
  return (await f.exists()) ? ((await f.json()) as SlangEntry[]) : [];
}

async function fullDict(): Promise<SlangEntry[]> {
  const user = await userDict();
  const overridden = new Set(user.map((e) => e.from));
  return [...DEFAULT_DICT.filter((e) => !overridden.has(e.from)), ...user];
}

await definePlugin({
  methods: {
    normalize: async (p: { text: string }) => normalize(p.text, await fullDict()),
    "dict.list": () => fullDict(),
    "dict.add": async (p: SlangEntry) => {
      if (!p.from || !p.to) throw new Error("from and to are required");
      const user = (await userDict()).filter((e) => e.from !== p.from);
      user.push({ from: p.from, to: p.to, ...(p.anywhere ? { anywhere: true } : {}) });
      await Bun.write(userDictPath, JSON.stringify(user, null, 2));
      return { ok: true, size: user.length };
    },
  },
}).run();
