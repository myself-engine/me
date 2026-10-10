// Deliberately non-conforming plugin: proves the conformance suite fails what it should.
// - writes plain text to stdout
// - ends every streaming op twice
// - never answers `hang`
// - ignores shutdown and keeps running
import { pumpLines } from "../../../../protocol/rpc.ts";

const send = (frame: object) => process.stdout.write(JSON.stringify(frame) + "\n");
process.stdout.write("hello from a plugin that forgot stdout is the protocol channel\n");

void pumpLines(Bun.stdin.stream(), (line) => {
  const f = JSON.parse(line);
  if (f.method === "initialize") return send({ jsonrpc: "2.0", id: f.id, result: { protocolVersion: 1, ready: true } });
  if (f.method !== "call") return;
  const { method, stream, opId } = f.params;
  if (method === "hang") return;
  if (method !== "twice") return send({ jsonrpc: "2.0", id: f.id, result: "unknown methods should be errors" });
  send({ jsonrpc: "2.0", id: f.id, result: stream ? { accepted: true } : { ok: true } });
  if (stream) {
    send({ jsonrpc: "2.0", method: "op.end", params: { opId, result: 1 } });
    send({ jsonrpc: "2.0", method: "op.end", params: { opId, result: 2 } });
  }
});
setInterval(() => {}, 1_000);
