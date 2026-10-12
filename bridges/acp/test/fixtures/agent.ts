// Tiny fake ACP agent for the bridge tests: JSON-RPC over stdio, no model. The prompt text picks the behaviour:
//   "slow"        one chunk, then waits for session/cancel and ends with stopReason "cancelled"
//   "stubborn"    ignores session/cancel and never ends the turn
//   "permission"  asks session/request_permission and reports the outcome as a chunk
//   "fs"          calls fs/read_text_file and reports the error code it got
//   "env"         reports FIXTURE_TOKEN
//   "crash"       exits
//   anything else three chunks echoing the prompt, then "end_turn"
// FIXTURE_PROTOCOL makes initialize answer with another protocol version.
import { Peer, RpcError } from "@me/protocol";
import { stdioTransport } from "@me/sdk";

let next = 1;
const sessions = new Map<string, { cwd: string; cancel?: () => void }>();

const peer: Peer = new Peer(stdioTransport(), {
  async onRequest(method, params: any) {
    if (method === "initialize") {
      return {
        protocolVersion: Number(process.env.FIXTURE_PROTOCOL ?? params.protocolVersion),
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "fixture-agent", version: "0.0.1" },
        authMethods: [],
        _meta: { clientCapabilities: params.clientCapabilities, clientInfo: params.clientInfo },
      };
    }
    if (method === "session/new") {
      const sessionId = `s${next++}`;
      sessions.set(sessionId, { cwd: params.cwd });
      return { sessionId, _meta: { cwd: params.cwd, mcpServers: params.mcpServers } };
    }
    if (method === "session/prompt") return prompt(params.sessionId, params.prompt);
    throw new RpcError(-32601, `no method ${method}`);
  },
  onNotification(method, params: any) {
    if (method === "session/cancel") sessions.get(params.sessionId)?.cancel?.();
  },
});

function say(sessionId: string, text: string) {
  peer.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
}

async function prompt(sessionId: string, blocks: any[]) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`unknown session ${sessionId}`);
  const text = blocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
  if (text === "crash") process.exit(1);
  if (text === "slow") {
    say(sessionId, "working");
    await new Promise<void>((r) => {
      s.cancel = r;
      setTimeout(r, 10_000);
    });
    return { stopReason: "cancelled" };
  }
  if (text === "stubborn") return new Promise(() => {});
  if (text === "permission") {
    peer.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "rm -rf /", status: "pending" } });
    const res = await peer.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t1", title: "rm -rf /" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    say(sessionId, `permission: ${res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"}`);
    return { stopReason: "end_turn" };
  }
  if (text === "fs") {
    const code = await peer.request("fs/read_text_file", { sessionId, path: "/etc/hosts" }).then(
      () => "ok",
      (e) => String(e.code),
    );
    say(sessionId, `fs: ${code}`);
    return { stopReason: "end_turn" };
  }
  if (text === "env") {
    say(sessionId, `env: ${process.env.FIXTURE_TOKEN ?? "unset"}`);
    return { stopReason: "end_turn" };
  }
  for (const part of ["echo", ": ", text]) {
    say(sessionId, part);
    await Bun.sleep(10);
  }
  return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 } };
}
