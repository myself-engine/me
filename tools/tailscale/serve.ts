// me tailscale on|off|status: put the localhost web UI on the tailnet with `tailscale serve`.
// Tailnet only. Funnel (public internet) is refused: no option here can produce it, every argv is checked, and
// enabling stops if funnel is already on for the HTTPS port (serve on a funnelled port would be public).
// Never touches a handler it does not own: `serve --https=<p> off` drops every handler on that port, so enable and
// disable both refuse when the port already proxies somewhere else.
// argv only, no shell. Tests inject a fake runner.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (argv: string[]) => Promise<RunResult>;

export interface ServeOptions {
  /** Defaults to running the real `tailscale` binary. */
  run?: Runner;
  /** HTTPS port on the tailnet hostname. Default 443. */
  httpsPort?: number;
}

export interface ServeHandler {
  /** `<machine>.<tailnet>.ts.net:<port>` */
  hostPort: string;
  path: string;
  proxy: string | null;
}

export interface ServeStatus {
  handlers: ServeHandler[];
  /** host:port entries with funnel (public exposure) on. */
  funnel: string[];
}

export const DEFAULT_WEB_PORT = 7420;

export const defaultRunner: Runner = async (argv) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
};

/** Throws unless argv is a `tailscale serve` invocation with nothing funnel-shaped in it. */
export function assertTailnetOnly(argv: string[]): void {
  if (argv[0] !== "tailscale" || argv[1] !== "serve") throw new Error(`refusing to run anything but tailscale serve: ${argv.join(" ")}`);
  if (argv.some((a) => a.toLowerCase().includes("funnel"))) throw new Error("refusing public exposure: funnel is never enabled by me");
}

function checkPort(name: string, p: number): void {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`invalid ${name}: ${p}`);
}

export const proxyTarget = (port: number) => `http://127.0.0.1:${port}`;

export function statusArgv(): string[] {
  return ["tailscale", "serve", "status", "--json"];
}

export function enableArgv(port: number, httpsPort = 443): string[] {
  checkPort("port", port);
  checkPort("httpsPort", httpsPort);
  const argv = ["tailscale", "serve", "--bg", `--https=${httpsPort}`, proxyTarget(port)];
  assertTailnetOnly(argv);
  return argv;
}

export function disableArgv(httpsPort = 443): string[] {
  checkPort("httpsPort", httpsPort);
  const argv = ["tailscale", "serve", `--https=${httpsPort}`, "off"];
  assertTailnetOnly(argv);
  return argv;
}

/** Parses `tailscale serve status --json`. Empty or non-JSON output means no config. */
export function parseServeStatus(out: string): ServeStatus {
  let j: any;
  try {
    j = JSON.parse(out);
  } catch {
    return { handlers: [], funnel: [] };
  }
  const handlers: ServeHandler[] = [];
  for (const [hostPort, web] of Object.entries<any>(j?.Web ?? {})) {
    for (const [path, h] of Object.entries<any>(web?.Handlers ?? {})) handlers.push({ hostPort, path, proxy: typeof h?.Proxy === "string" ? h.Proxy : null });
  }
  const funnel = Object.entries<any>(j?.AllowFunnel ?? {})
    .filter(([, on]) => on === true)
    .map(([hp]) => hp);
  return { handlers, funnel };
}

const onPort = (hostPort: string, httpsPort: number) => hostPort.endsWith(`:${httpsPort}`);
const isOurs = (h: ServeHandler, port: number) => h.path === "/" && (h.proxy === proxyTarget(port) || h.proxy === `127.0.0.1:${port}`);

async function exec(run: Runner, argv: string[]): Promise<string> {
  assertTailnetOnly(argv);
  const r = await run(argv);
  if (r.code !== 0) throw new Error(`${argv.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout;
}

export async function serveStatus(opts: ServeOptions = {}): Promise<ServeStatus> {
  return parseServeStatus(await exec(opts.run ?? defaultRunner, statusArgv()));
}

/** Proxies https://<hostname>:<httpsPort> on the tailnet to 127.0.0.1:<port>. */
export async function serveEnable(port: number, opts: ServeOptions = {}): Promise<{ changed: boolean; status: ServeStatus }> {
  const run = opts.run ?? defaultRunner;
  const httpsPort = opts.httpsPort ?? 443;
  const argv = enableArgv(port, httpsPort);
  const before = await serveStatus({ run });
  if (before.funnel.some((hp) => onPort(hp, httpsPort))) throw new Error(`funnel is on for port ${httpsPort}; refusing to serve there (it would be public). Turn funnel off first.`);
  const existing = before.handlers.filter((h) => onPort(h.hostPort, httpsPort));
  if (existing.length > 0 && existing.every((h) => isOurs(h, port))) return { changed: false, status: before };
  if (existing.length > 0) {
    const what = existing.map((h) => `${h.path} → ${h.proxy ?? "?"}`).join(", ");
    throw new Error(`https port ${httpsPort} is already serving ${what}; pick another httpsPort (e.g. 8443) or remove that handler yourself`);
  }
  await exec(run, argv);
  const after = await serveStatus({ run });
  if (after.funnel.some((hp) => onPort(hp, httpsPort))) {
    await exec(run, disableArgv(httpsPort));
    throw new Error(`funnel turned out to be on for port ${httpsPort}; serve removed again`);
  }
  return { changed: true, status: after };
}

/** Removes the handler serveEnable added. Refuses when the port serves anything else. */
export async function serveDisable(opts: ServeOptions & { port?: number } = {}): Promise<{ changed: boolean; status: ServeStatus }> {
  const run = opts.run ?? defaultRunner;
  const httpsPort = opts.httpsPort ?? 443;
  const port = opts.port ?? DEFAULT_WEB_PORT;
  const argv = disableArgv(httpsPort);
  const before = await serveStatus({ run });
  const existing = before.handlers.filter((h) => onPort(h.hostPort, httpsPort));
  if (existing.length === 0) return { changed: false, status: before };
  if (!existing.every((h) => isOurs(h, port))) {
    const what = existing.map((h) => `${h.path} → ${h.proxy ?? "?"}`).join(", ");
    throw new Error(`https port ${httpsPort} serves ${what}, not only ${proxyTarget(port)}; refusing to remove it`);
  }
  await exec(run, argv);
  return { changed: true, status: await serveStatus({ run }) };
}
