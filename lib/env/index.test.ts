import { describe, expect, test } from "bun:test";
import { childEnv, isBaseEnv, validateEnvPass } from "./index.ts";

const FROM = {
  PATH: "/bin",
  HOME: "/home/u",
  LANG: "ko_KR.UTF-8",
  LC_ALL: "ko_KR.UTF-8",
  TZ: "Asia/Seoul",
  TMPDIR: "/tmp/x",
  TERM: "xterm",
  COLORTERM: "truecolor",
  XDG_CONFIG_HOME: "/home/u/.config",
  SSH_AUTH_SOCK: "/tmp/sock",
  HERDR_PANE: "3",
  ME_HOME: "/home/u/.me",
  ME_DATA_DIR: "/home/u/.me",
  USER: "u",
  LOGNAME: "u",
  SHELL: "/bin/zsh",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYSECRETKEY",
  ANTHROPIC_API_KEY: "sk-ant-x",
  GH_TOKEN: "ghp_abc",
  MYAPP_KEY: "k",
  OTHER: "o",
};

describe("childEnv", () => {
  test("keeps the base set and drops secret-looking names", () => {
    const env = childEnv([], {}, FROM);
    for (const k of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "TERM", "COLORTERM", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "HERDR_PANE", "ME_HOME", "ME_DATA_DIR"]) {
      expect(env[k]).toBe(FROM[k as keyof typeof FROM]);
    }
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("OTHER");
  });

  test("exact names in the pass list are kept", () => {
    const env = childEnv(["GH_TOKEN"], {}, FROM);
    expect(env.GH_TOKEN).toBe("ghp_abc");
    expect(env).not.toHaveProperty("OTHER");
  });

  test("PREFIX_* globs keep their prefix only", () => {
    const env = childEnv(["MYAPP_*"], {}, FROM);
    expect(env.MYAPP_KEY).toBe("k");
    expect(env).not.toHaveProperty("OTHER");
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  test("extra values always win, even for unlisted names", () => {
    const env = childEnv([], { CUSTOM: "1", PATH: "/extra" }, FROM);
    expect(env.CUSTOM).toBe("1");
    expect(env.PATH).toBe("/extra");
  });

  test("base detection", () => {
    expect(isBaseEnv("PATH")).toBe(true);
    expect(isBaseEnv("LC_MESSAGES")).toBe(true);
    expect(isBaseEnv("XDG_DATA_HOME")).toBe(true);
    expect(isBaseEnv("HERDR_X")).toBe(true);
    expect(isBaseEnv("ME_PLUGIN_ID")).toBe(true);
    expect(isBaseEnv("GH_TOKEN")).toBe(false);
  });
});

describe("validateEnvPass", () => {
  test('refuses the "*" wildcard', () => {
    expect(() => validateEnvPass(["*"])).toThrow("*");
    expect(() => validateEnvPass(["A*B"])).toThrow("PREFIX_*");
    expect(() => validateEnvPass(["*SUFFIX"])).toThrow("PREFIX_*");
  });

  test("refuses non-strings and bad names", () => {
    expect(() => validateEnvPass("GH_TOKEN" as any)).toThrow("array");
    expect(() => validateEnvPass([1] as any)).toThrow("non-empty strings");
    expect(() => validateEnvPass(["has space"])).toThrow("invalid variable name");
    expect(() => validateEnvPass([" WESTERN*"])).toThrow("invalid prefix");
  });

  test("accepts exact names and PREFIX_* globs", () => {
    expect(validateEnvPass(["GH_TOKEN", "MYAPP_*", "LC_*"])).toEqual(["GH_TOKEN", "MYAPP_*", "LC_*"]);
  });
});
