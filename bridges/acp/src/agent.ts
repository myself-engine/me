// Connection to one ACP agent process: JSON-RPC 2.0 as NDJSON over the child's stdin/stdout,
// spawned and initialized on demand and respawned after it exits (its sessions die with it).
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ErrorCode, Peer, RpcError, pumpLines, type LineTransport } from "@me/protocol";
import {
  ACP_PROTOCOL_VERSION,
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  decidePermission,
  messageText,
  type AcpConfig,
  type ContentBlock,
  type PermissionOption,
} from "./config.ts";

export interface PromptResult {
  sessionId: string;
  stopReason: string;
  /** Concatenated text of the agent_message_chunk updates of this turn. */
  text: string;
  usage?: unknown;
}

/** Receives one session's updates while a prompt runs. */
interface Turn {
  onUpdate(update: unknown): void;
  /** Set once session/cancel was sent; later permission requests are answered cancelled (ACP prompt-turn rules). */
  cancelled: boolean;
}

interface Live {
  proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">>;
  peer: Peer;
  init: any;
  turns: Map<string, Turn>;
}

function expandHome(p: string) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** Reads env values from files. Errors name the variable and path, never the content. */
async function readEnvFiles(files: Record<string, string> = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, file] of Object.entries(files)) {
    const path = expandHome(file);
    try {
      out[name] = (await Bun.file(path).text()).trim();
    } catch {
      throw new Error(`env file for ${name} is unreadable: ${path}`);
    }
  }
  return out;
}

/** Line transport over a child's stdio. Closes when its stdout ends or shortly after it exits. */
function processTransport(proc: Live["proc"]): LineTransport {
  const lineCbs: ((l: string) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    closeCbs.forEach((cb) => cb());
  };
  void pumpLines(proc.stdout, (l) => lineCbs.forEach((cb) => cb(l)))
    .catch(() => {})
    .finally(finish);
  // A grandchild can hold stdout open after the agent exits; don't wait on it for long.
  void proc.exited.then(() => setTimeout(finish, 200));
  return {
    send(line) {
      if (closed) return;
      try {
        proc.stdin.write(line + "\n");
        proc.stdin.flush();
      } catch {
        // The child is gone; onClose follows.
      }
    },
    onLine: (cb) => lineCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close() {
      try {
        proc.stdin.end();
      } catch {}
    },
  };
}

export class AgentConnection {
  private live: Live | null = null;
  private connecting: Promise<Live> | null = null;

  constructor(
    private config: AcpConfig,
    private clientName = "me-acp-bridge",
  ) {}

  /** The running agent, spawning and initializing it first if needed. */
  async get(): Promise<Live> {
    if (this.live) return this.live;
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** The agent's initialize result (protocolVersion, agentCapabilities, agentInfo, authMethods). */
  async info(): Promise<unknown> {
    return (await this.get()).init;
  }

  private async connect(): Promise<Live> {
    const a = this.config.agent;
    const env = { ...(process.env as Record<string, string>), ...(a.env ?? {}), ...(await readEnvFiles(a.envFiles)) };
    let proc: Live["proc"];
    try {
      // stderr is inherited so the agent's logs land in this plugin's log; stdout carries only ACP frames.
      proc = Bun.spawn([a.command, ...(a.args ?? [])], { cwd: a.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    } catch (err) {
      throw new Error(`cannot start ACP agent ${a.command}: ${(err as Error).message}`);
    }
    const turns = new Map<string, Turn>();
    const live: Live = { proc, peer: null as unknown as Peer, init: null, turns };
    live.peer = new Peer(processTransport(proc), {
      onRequest: (method, params) => this.onAgentRequest(live, method, params),
      onNotification: (method, params) => {
        if (method !== "session/update") return;
        const turn = turns.get(params?.sessionId);
        if (turn) turn.onUpdate(params.update);
      },
      onClose: () => {
        if (this.live === live) this.live = null;
      },
    });
    try {
      const init = await live.peer.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // No client-side file system or terminal: the agent works in its own process only.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: this.clientName, version: "0.1.0" },
        },
        this.config.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
      );
      if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(`agent speaks ACP version ${init?.protocolVersion}; this bridge speaks ${ACP_PROTOCOL_VERSION}`);
      }
      live.init = init;
    } catch (err) {
      await stopProcess(live);
      throw new Error(`ACP initialize failed: ${(err as Error).message}`);
    }
    if (live.peer.isClosed) throw new Error("ACP agent exited right after initialize");
    this.live = live;
    return live;
  }

  /** Requests the agent makes of the client. Only permission requests are supported. */
  private onAgentRequest(live: Live, method: string, params: any) {
    if (method === "session/request_permission") {
      const turn = live.turns.get(params?.sessionId);
      const options: PermissionOption[] = Array.isArray(params?.options) ? params.options : [];
      const outcome = turn?.cancelled ? { outcome: "cancelled" as const } : decidePermission(this.config.permission ?? "reject", options);
      turn?.onUpdate({ permission: { toolCall: params?.toolCall ?? null, options, outcome } });
      return { outcome };
    }
    throw new RpcError(-32601, `${method} is not supported by the me ACP bridge`);
  }

  /** session/new in the given absolute directory (default: config.cwd, agent.cwd, then this process's cwd). */
  async newSession(cwd?: string): Promise<{ sessionId: string; [k: string]: unknown }> {
    const dir = cwd ?? this.config.cwd ?? resolve(this.config.agent.cwd ?? process.cwd());
    const live = await this.get();
    const res = await live.peer.request("session/new", { cwd: dir, mcpServers: [] }, this.config.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);
    if (typeof res?.sessionId !== "string") throw new RpcError(-32603, "agent returned no sessionId");
    return res;
  }

  /**
   * Runs one prompt turn. Each session/update for the session goes to `onUpdate`. When `signal` aborts,
   * session/cancel is sent and the turn ends as Cancelled once the agent answers (or after the grace period).
   */
  async prompt(sessionId: string, prompt: ContentBlock[], onUpdate: (u: unknown) => void, signal?: AbortSignal): Promise<PromptResult> {
    const live = await this.get();
    if (live.turns.has(sessionId)) throw new RpcError(-32602, `session ${sessionId} already has a prompt running`);
    if (signal?.aborted) throw new RpcError(ErrorCode.Cancelled, "cancelled");
    let text = "";
    const turn: Turn = {
      cancelled: false,
      onUpdate(u) {
        text += messageText(u);
        onUpdate(u);
      },
    };
    live.turns.set(sessionId, turn);

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const gaveUp = new Promise<never>((_, reject) => {
      onAbort = () => {
        this.sendCancel(live, sessionId);
        graceTimer = setTimeout(
          () => reject(new RpcError(ErrorCode.Cancelled, "cancelled; the agent did not end the turn")),
          this.config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
        );
      };
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = this.config.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    try {
      const res = await Promise.race([live.peer.request("session/prompt", { sessionId, prompt }, timeoutMs), gaveUp]);
      if (signal?.aborted) throw new RpcError(ErrorCode.Cancelled, `cancelled (agent stopped: ${res?.stopReason})`, { stopReason: res?.stopReason, text });
      const result: PromptResult = { sessionId, stopReason: res?.stopReason, text };
      if (res?.usage) result.usage = res.usage;
      return result;
    } catch (err) {
      if (err instanceof RpcError && err.code === ErrorCode.Timeout) {
        this.sendCancel(live, sessionId);
        throw new RpcError(ErrorCode.Timeout, `prompt timed out after ${timeoutMs}ms; session/cancel sent`);
      }
      if (err instanceof RpcError && err.code === ErrorCode.TargetUnavailable && live.peer.isClosed) {
        throw new RpcError(ErrorCode.TargetUnavailable, "ACP agent exited during the prompt");
      }
      throw err;
    } finally {
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      live.turns.delete(sessionId);
    }
  }

  /** Sends session/cancel for a session (a notification; the running prompt then ends with stopReason "cancelled"). */
  async cancel(sessionId: string) {
    const live = await this.get();
    this.sendCancel(live, sessionId);
  }

  private sendCancel(live: Live, sessionId: string) {
    const turn = live.turns.get(sessionId);
    if (turn) turn.cancelled = true;
    live.peer.notify("session/cancel", { sessionId });
  }

  async close() {
    const live = this.live;
    this.live = null;
    if (live) await stopProcess(live);
  }
}

/** Closes stdin, then SIGTERM, then SIGKILL if the agent is still there after a grace period. */
async function stopProcess(live: Live, graceMs = 1_000) {
  live.peer.close();
  live.proc.kill("SIGTERM");
  const exited = await Promise.race([live.proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  if (!exited) live.proc.kill("SIGKILL");
}
