// ACP probe: drive `gjc --mode acp` over stdio JSON-RPC and record every frame.
// Usage: bun spikes/gjc-headless/acp-probe.ts <model> <out.ndjson> "<prompt>"
const [model, outPath, prompt] = Bun.argv.slice(2);
if (!model || !outPath || !prompt) {
  console.error("usage: acp-probe.ts <model> <out.ndjson> <prompt>");
  process.exit(2);
}

const proc = Bun.spawn(
  ["gjc", "--mode", "acp", "--model", model],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: process.cwd() },
);

const out = Bun.file(outPath).writer();
const log = (dir: "in" | "out", frame: unknown) => out.write(JSON.stringify({ dir, frame }) + "\n");

let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

function send(msg: object) {
  log("out", msg);
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function request(method: string, params: object): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function handle(msg: any) {
  log("in", msg);
  if (msg.id !== undefined && pending.has(msg.id) && msg.method === undefined) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
    return;
  }
  // Agent-initiated requests: deny anything that would act on the client side.
  if (msg.id !== undefined && msg.method) {
    if (msg.method === "session/request_permission") {
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by probe" } });
    }
  }
}

(async () => {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        log("in", { nonJson: line.slice(0, 500) });
      }
    }
  }
})();

const timeout = setTimeout(() => {
  console.error("timeout");
  proc.kill();
  process.exit(3);
}, 150_000);

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});
console.error("initialize:", JSON.stringify(init.result ?? init.error).slice(0, 600));

const sess = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
console.error("session/new:", JSON.stringify(sess.result ?? sess.error).slice(0, 4000));
const sessionId = sess.result?.sessionId;

if (sessionId && process.env.ACP_MODE) {
  const set = await request("session/set_config_option", { sessionId, configId: "mode", value: process.env.ACP_MODE });
  console.error("set mode:", JSON.stringify(set.result ?? set.error).slice(0, 300));
}

if (sessionId) {
  const res = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  console.error("session/prompt:", JSON.stringify(res.result ?? res.error).slice(0, 300));
}

clearTimeout(timeout);
proc.kill();
await out.end();
process.exit(0);
