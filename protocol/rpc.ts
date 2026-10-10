// JSON-RPC 2.0 peer over a line transport (NDJSON). Shared by the kernel and the plugin SDK.
import type { Socket } from "node:net";
import type { JsonValue, RpcFrame, RpcId } from "./types.ts";

export interface LineTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
  }
}

export interface PeerHandlers {
  onRequest(method: string, params: any): Promise<unknown> | unknown;
  onNotification(method: string, params: any): void;
  onClose?(): void;
  /** Called for every inbound and outbound frame; used by the kernel for diagnostics. */
  onFrame?(dir: "in" | "out", frame: RpcFrame): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Peer {
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private closed = false;

  constructor(
    private transport: LineTransport,
    private handlers: PeerHandlers,
  ) {
    transport.onLine((line) => this.receive(line));
    transport.onClose(() => {
      this.closed = true;
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new RpcError(-32002, "peer closed"));
      }
      this.pending.clear();
      handlers.onClose?.();
    });
  }

  get isClosed() {
    return this.closed;
  }

  request<R = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<R> {
    if (this.closed) return Promise.reject(new RpcError(-32002, "peer closed"));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RpcError(-32003, `timeout after ${timeoutMs}ms: ${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  close() {
    this.transport.close();
  }

  private write(frame: RpcFrame) {
    this.handlers.onFrame?.("out", frame);
    this.transport.send(JSON.stringify(frame));
  }

  private receive(line: string) {
    if (!line.trim()) return;
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    this.handlers.onFrame?.("in", frame);
    if (frame.method !== undefined) {
      if (frame.id !== undefined && frame.id !== null) void this.answer(frame.id, frame.method, frame.params);
      else {
        try {
          this.handlers.onNotification(frame.method, frame.params);
        } catch (err) {
          console.error(`[rpc] notification handler failed for ${frame.method}:`, err);
        }
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.error) pending.reject(new RpcError(frame.error.code, frame.error.message, frame.error.data));
    else pending.resolve(frame.result);
  }

  private async answer(id: RpcId, method: string, params: unknown) {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: (result ?? null) as JsonValue });
    } catch (err) {
      const e =
        err instanceof RpcError
          ? { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
          : { code: -32603, message: err instanceof Error ? err.message : String(err) };
      this.write({ jsonrpc: "2.0", id, error: e });
    }
  }
}

/** Splits a byte stream into lines and feeds them to `cb`. */
export async function pumpLines(stream: ReadableStream<Uint8Array>, cb: (line: string) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) cb(line);
    }
  }
  if (buf.trim()) cb(buf);
}

/** Two connected in-memory transports, for tests and in-process plugins. */
export function createPipePair(): [LineTransport, LineTransport] {
  const make = () => {
    const lineCbs: ((l: string) => void)[] = [];
    const closeCbs: (() => void)[] = [];
    return { lineCbs, closeCbs, closed: false };
  };
  const a = make();
  const b = make();
  const side = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): LineTransport => ({
    send(line) {
      if (self.closed) return;
      queueMicrotask(() => other.lineCbs.forEach((cb) => cb(line)));
    },
    onLine(cb) {
      self.lineCbs.push(cb);
    },
    onClose(cb) {
      self.closeCbs.push(cb);
    },
    close() {
      if (self.closed) return;
      self.closed = true;
      other.closed = true;
      queueMicrotask(() => {
        self.closeCbs.forEach((cb) => cb());
        other.closeCbs.forEach((cb) => cb());
      });
    },
  });
  return [side(a, b), side(b, a)];
}

/** NDJSON over a connected stream socket (exec mode B: Unix socket, later others). */
export function socketLineTransport(sock: Socket): LineTransport {
  const lineCbs: ((l: string) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let buf = "";
  let closed = false;
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) lineCbs.forEach((cb) => cb(line));
    }
  });
  sock.on("error", () => {}); // "close" follows
  sock.on("close", () => {
    if (closed) return;
    closed = true;
    closeCbs.forEach((cb) => cb());
  });
  return {
    send: (line) => {
      if (!sock.destroyed && sock.writable) sock.write(line + "\n");
    },
    onLine: (cb) => lineCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => {
      if (closed || sock.destroyed) return;
      sock.end(); // flushes pending writes first
      setTimeout(() => sock.destroy(), 1_000).unref();
    },
  };
}

/**
 * Splits off the first inbound line (a handshake frame such as `hello`). Later lines are queued
 * until `rest` gets a listener, so frames that arrive in the same chunk as the handshake are not lost.
 */
export function takeFirstLine(transport: LineTransport): { first: Promise<string>; rest: LineTransport } {
  let got = false;
  let resolveFirst!: (l: string) => void;
  let rejectFirst!: (e: Error) => void;
  const first = new Promise<string>((res, rej) => ((resolveFirst = res), (rejectFirst = rej)));
  const lineCbs: ((l: string) => void)[] = [];
  const queue: string[] = [];
  transport.onLine((line) => {
    if (!got) {
      got = true;
      resolveFirst(line);
    } else if (lineCbs.length && !queue.length) lineCbs.forEach((cb) => cb(line));
    else queue.push(line); // the pending flush drains it, keeping order
  });
  transport.onClose(() => {
    if (!got) rejectFirst(new Error("closed before the first line"));
  });
  const rest: LineTransport = {
    send: (line) => transport.send(line),
    onLine(cb) {
      lineCbs.push(cb);
      if (lineCbs.length === 1 && queue.length) {
        queueMicrotask(() => {
          while (queue.length) {
            const l = queue.shift()!;
            lineCbs.forEach((c) => c(l));
          }
        });
      }
    },
    // Deferred so queued lines are delivered before the close.
    onClose: (cb) => transport.onClose(() => queueMicrotask(cb)),
    close: () => transport.close(),
  };
  return { first, rest };
}
