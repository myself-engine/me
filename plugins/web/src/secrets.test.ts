import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stashSecrets } from "./secrets.ts";

describe("stashSecrets", () => {
  test("secret values become file references; files are 0600; the rest passes through", () => {
    const home = mkdtempSync(join(tmpdir(), "me-web-secrets-"));
    const out = stashSecrets(
      "my server",
      { kind: "url", url: "https://x", headers: { Authorization: "Bearer abc", Accept: "application/json" }, env: { API_KEY: "", MODE: "acp", T: "${env:T}" } },
      home,
    ) as any;
    expect(out.headers).toEqual({ Authorization: "${file:~/.config/me/secrets/mcp/my_server-AUTHORIZATION}", Accept: "application/json" });
    expect(out.env).toEqual({ API_KEY: "", MODE: "acp", T: "${env:T}" });
    const file = join(home, ".config/me/secrets/mcp/my_server-AUTHORIZATION");
    expect(readFileSync(file, "utf8")).toBe("Bearer abc\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(out)).not.toContain("Bearer abc");
    // Typing a new value replaces the stored one.
    stashSecrets("my server", { headers: { Authorization: "Bearer xyz" } }, home);
    expect(readFileSync(file, "utf8")).toBe("Bearer xyz\n");
  });
});
