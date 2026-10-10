import { describe, expect, test } from "bun:test";
import { assertTailnetOnly, disableArgv, enableArgv, parseServeStatus, type Runner, serveDisable, serveEnable, serveStatus } from "./serve.ts";

const HOST = "mac.tail0.ts.net";

/** Fake tailscale: records argv, answers `serve status --json` from a mutable config, never runs anything real. */
function fake(initial: Record<string, unknown> = {}) {
  let config: any = initial;
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    if (argv.join(" ") === "tailscale serve status --json") return { code: 0, stdout: JSON.stringify(config), stderr: "" };
    const https = argv.find((a) => a.startsWith("--https="))?.slice(8);
    if (argv.at(-1) === "off") {
      const web = { ...config.Web };
      delete web[`${HOST}:${https}`];
      config = { ...config, Web: web };
    } else {
      config = { ...config, Web: { ...config.Web, [`${HOST}:${https}`]: { Handlers: { "/": { Proxy: argv.at(-1) } } } } };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, mutating: () => calls.filter((c) => c[2] !== "status") };
}

describe("argv", () => {
  test("enable proxies the https port to loopback in the background", () => {
    expect(enableArgv(7420)).toEqual(["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:7420"]);
    expect(enableArgv(7420, 8443)).toEqual(["tailscale", "serve", "--bg", "--https=8443", "http://127.0.0.1:7420"]);
  });

  test("disable turns off only that https port", () => {
    expect(disableArgv(8443)).toEqual(["tailscale", "serve", "--https=8443", "off"]);
  });

  test("invalid ports are rejected", () => {
    expect(() => enableArgv(0)).toThrow();
    expect(() => enableArgv(70000)).toThrow();
    expect(() => enableArgv(7420.5)).toThrow();
  });

  test("funnel and anything that is not tailscale serve are refused", () => {
    expect(() => assertTailnetOnly(["tailscale", "serve", "--funnel", "7420"])).toThrow(/funnel/);
    expect(() => assertTailnetOnly(["tailscale", "funnel", "7420"])).toThrow();
    expect(() => assertTailnetOnly(["tailscale", "serve", "--bg", "--set-funnel=on"])).toThrow(/funnel/);
    expect(() => assertTailnetOnly(["sh", "-c", "tailscale serve 7420"])).toThrow();
    expect(() => assertTailnetOnly(enableArgv(7420))).not.toThrow();
  });
});

describe("parseServeStatus", () => {
  test("reads handlers and funnel flags", () => {
    const s = parseServeStatus(
      JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } } },
        AllowFunnel: { [`${HOST}:443`]: true, [`${HOST}:8443`]: false },
      }),
    );
    expect(s).toEqual({ handlers: [{ hostPort: `${HOST}:443`, path: "/", proxy: "http://127.0.0.1:7317" }], funnel: [`${HOST}:443`] });
  });

  test("empty or non-JSON output is no config", () => {
    expect(parseServeStatus("{}")).toEqual({ handlers: [], funnel: [] });
    expect(parseServeStatus("null")).toEqual({ handlers: [], funnel: [] });
    expect(parseServeStatus("No serve config")).toEqual({ handlers: [], funnel: [] });
  });
});

describe("serveEnable / serveDisable / serveStatus", () => {
  test("status runs only the read-only status command", async () => {
    const f = fake();
    await serveStatus({ run: f.run });
    expect(f.calls).toEqual([["tailscale", "serve", "status", "--json"]]);
  });

  test("enable on a free port runs the serve argv and never mentions funnel", async () => {
    const f = fake();
    const r = await serveEnable(7420, { run: f.run });
    expect(r.changed).toBe(true);
    expect(f.mutating()).toEqual([["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:7420"]]);
    expect(f.calls.flat().some((a) => a.includes("funnel"))).toBe(false);
  });

  test("enable is a no-op when already serving this port", async () => {
    const f = fake({ Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7420" } } } } });
    expect((await serveEnable(7420, { run: f.run })).changed).toBe(false);
    expect(f.mutating()).toEqual([]);
  });

  test("enable refuses to clobber another handler on the same https port", async () => {
    const f = fake({ Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } } } });
    await expect(serveEnable(7420, { run: f.run })).rejects.toThrow(/already serving/);
    expect(f.mutating()).toEqual([]);
    expect((await serveEnable(7420, { run: f.run, httpsPort: 8443 })).changed).toBe(true);
  });

  test("enable refuses when funnel is on for the https port", async () => {
    const f = fake({ AllowFunnel: { [`${HOST}:443`]: true } });
    await expect(serveEnable(7420, { run: f.run })).rejects.toThrow(/funnel/);
    expect(f.mutating()).toEqual([]);
  });

  test("disable removes only our handler and refuses foreign ones", async () => {
    const ours = fake({ Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7420" } } } } });
    expect((await serveDisable({ run: ours.run })).changed).toBe(true);
    expect(ours.mutating()).toEqual([["tailscale", "serve", "--https=443", "off"]]);

    const foreign = fake({ Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } } } });
    await expect(serveDisable({ run: foreign.run })).rejects.toThrow(/refusing/);
    expect(foreign.mutating()).toEqual([]);

    const none = fake();
    expect((await serveDisable({ run: none.run })).changed).toBe(false);
  });

  test("a failing tailscale command surfaces its stderr", async () => {
    const run: Runner = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
    await expect(serveStatus({ run })).rejects.toThrow(/not logged in/);
  });
});
