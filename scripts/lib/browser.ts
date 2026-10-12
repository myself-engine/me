// Shared harness for scripts/shots.ts and scripts/a11y.ts:
// a seeded throwaway me (scripts/e2e.ts --serve) plus a headless Chrome driven over CDP.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export type Seeded = { url: string; threadId: string | null; taskId: string | null; resultThreadId: string | null; stop: () => Promise<void> };

/** Starts a seeded me and returns its URL with one thread and one task id. Stop it with stop(); only that PID is signalled. */
export async function startSeededMe(): Promise<Seeded> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "e2e.ts"), "--serve"], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let buf = "";
  const deadline = Date.now() + 240_000;
  while (!/SERVE (\S+)/.test(buf)) {
    if (Date.now() > deadline) throw (proc.kill(), new Error("seeded me did not start"));
    const { value, done } = await reader.read();
    if (done) throw new Error(`seeded me exited:\n${buf}`);
    buf += new TextDecoder().decode(value);
  }
  const url = buf.match(/SERVE (\S+)/)![1]!;
  const boot: any = await (await fetch(`${url}api/bootstrap`)).json();
  // The thread whose delegation result waits for review, so the in-thread result card is covered.
  const sealed = boot.tasks?.find((t: any) => t.state === "sealed")?.taskId;
  return {
    url,
    // Prefer the thread with the pending delegation approval, so the in-thread approval card is covered.
    threadId: boot.messages?.find((m: any) => m.id === boot.approvals?.[0]?.payload?.messageId)?.threadId ?? boot.threads?.[0]?.id ?? null,
    taskId: boot.tasks?.[0]?.taskId ?? null,
    resultThreadId: boot.messages?.find((m: any) => sealed && m.taskId === sealed)?.threadId ?? null,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

export type Page = {
  cdp: (method: string, params?: object) => Promise<any>;
  eval: <T = any>(expr: string) => Promise<T>;
  until: (expr: string, ms?: number) => Promise<void>;
  viewport: (width: number, height: number, mobile: boolean) => Promise<void>;
  scheme: (s: "light" | "dark") => Promise<void>;
  open: (url: string, ready: string) => Promise<void>;
  png: () => Promise<Buffer>;
  close: () => Promise<void>;
};

/** Launches headless Chrome with a throwaway profile on a free debugging port. */
export async function launchChrome(): Promise<Page> {
  const profile = mkdtempSync(join(tmpdir(), "me-chrome-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = Bun.spawn(
    [CHROME, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  let target: any;
  for (let i = 0; i < 50 && !target; i++) {
    target = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .then((l: any[]) => l.find((t) => t.type === "page"))
      .catch(() => Bun.sleep(200).then(() => undefined));
  }
  if (!target) throw (chrome.kill(), new Error("chrome did not start"));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) (pending.get(m.id)!(m), pending.delete(m.id));
  };
  const cdp = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const n = ++seq;
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expr: string) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const until = async (expr: string, ms = 15_000) => {
    for (let t = 0; t < ms; t += 150) {
      if (await evaluate(expr).catch(() => false)) return;
      await Bun.sleep(150);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  return {
    cdp,
    eval: evaluate,
    until,
    // Mobile viewports also emulate touch, so `(pointer: coarse)` rules (44px targets) are what gets checked.
    viewport: async (width, height, mobile) => {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });
      await cdp("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await cdp("Emulation.setEmitTouchEventsForMouse", { enabled: mobile, configuration: "mobile" });
    },
    scheme: (s) => cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: s }] }),
    open: async (url, ready) => {
      await cdp("Page.navigate", { url });
      await until(ready);
      await Bun.sleep(400); // let transitions settle
    },
    png: async () => Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"),
    close: async () => {
      ws.close();
      chrome.kill();
      await chrome.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** A screen to check: a hash route, optionally with a control clicked open (a sheet or dialog). */
export type Screen = { name: string; hash: string; open?: string };

/** Opens a screen and, when it has one, clicks its control and waits for the dialog it opens. */
export async function show(page: Page, url: string, s: Screen) {
  await page.open(url + s.hash, READY);
  if (!s.open) return;
  // Same-hash navigation does not reload, so a dialog left open by the previous screen stays mounted.
  await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await page.until("!(document.querySelector('[role=dialog]')?.getBoundingClientRect().height > 0)");
  await page.eval(`document.querySelector(${JSON.stringify(s.open)}).click()`);
  // Visible, not merely in the DOM: a dialog inside a hidden pane would pass a presence check.
  if (s.open.includes("summary")) return; // a fold opens in place
  await page.until("(document.querySelector('[role=dialog]')?.getBoundingClientRect().height ?? 0) > 0");
  await Bun.sleep(300); // the model list arrives over the socket
}

/** The screens every visual check walks, as hash routes. */
export function screens(s: Seeded): Screen[] {
  return [
    { name: "chat-new", hash: "#/chat" },
    { name: "head-picker", hash: "#/chat/new", open: ".head-chip" },
    { name: "project-picker", hash: "#/chat/new", open: ".project-button" },
    ...(s.threadId ? [{ name: "chat-thread", hash: `#/chat/${encodeURIComponent(s.threadId)}` }] : []),
    ...(s.resultThreadId ? [{ name: "chat-result", hash: `#/chat/${encodeURIComponent(s.resultThreadId)}` }] : []),
    { name: "tasks", hash: "#/tasks" },
    ...(s.taskId ? [{ name: "task-detail", hash: `#/tasks/${encodeURIComponent(s.taskId)}` }] : []),
    { name: "status", hash: "#/ops" },
    { name: "status-advanced", hash: "#/ops", open: ".fold.advanced > summary" },
  ];
}

export const VIEWPORTS = [
  { name: "360", width: 360, height: 760, mobile: true },
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "768", width: 768, height: 1024, mobile: true },
  { name: "1280", width: 1280, height: 820, mobile: false },
  // A 1280px desktop window at 200% browser zoom lays out like a 640px-wide one.
  { name: "640z", width: 640, height: 410, mobile: false },
];

/** Interactive elements smaller than 44×44 CSS px on a touch screen (inline markdown links excepted). */
export const SMALL_TARGETS = `[...document.querySelectorAll('a[href], button, select, summary, textarea, [role=button]')]
  .filter((el) => !el.closest('.md') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
  .map((el) => [el, el.getBoundingClientRect()])
  .filter(([el, r]) => r.width > 0 && (r.height < 43.5 || r.width < 43.5) && !el.classList.contains('skip'))
  .map(([el, r]) => (el.className || el.tagName.toLowerCase()) + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height))`;

/** Ready condition: the React root has rendered something. */
export const READY = "!!document.querySelector('#root')?.children.length";
