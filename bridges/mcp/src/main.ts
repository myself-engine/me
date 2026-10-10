// MCP bridge: exposes one MCP server as a me plugin with a fixed method set.
// MCP tools are dynamic, but manifests must list methods before spawn, so the bridge
// provides generic methods (tools.list, tools.call, resources.*) instead of one per tool.
//
// Instance manifest example (plugins/mcp-notion/plugin.json):
//   "run": { "command": ["bun", "../../bridges/mcp/src/main.ts"] }
//   "provides": { "methods": ["tools.list", "tools.call", "resources.list", "resources.read"] }
// and in me.config.json: "pluginConfig": { "mcp-notion": { "server": { "command": "...", "args": [...] } } }
import { definePlugin } from "@me/sdk";
import { McpConnection, type McpServerConfig } from "./client.ts";

let conn: McpConnection | null = null;

const plugin = definePlugin({
  async onInit(info) {
    const server = info.config.server as unknown as McpServerConfig | undefined;
    if (!server?.command) throw new Error(`${info.pluginId}: config.server.command is required`);
    conn = new McpConnection(server, `me:${info.pluginId}`);
    await conn.get();
  },
  async onShutdown() {
    await conn?.close();
  },
  methods: {
    "tools.list": async () => {
      const { tools } = await (await conn!.get()).listTools();
      return tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
    },
    "tools.call": async (p: { name: string; arguments?: Record<string, unknown> }) => {
      if (!p?.name) throw new Error("name is required");
      const res = await (await conn!.get()).callTool({ name: p.name, arguments: p.arguments ?? {} });
      return res;
    },
    "resources.list": async () => {
      const client = await conn!.get();
      if (!client.getServerCapabilities()?.resources) return [];
      return (await client.listResources()).resources;
    },
    "resources.read": async (p: { uri: string }) => {
      if (!p?.uri) throw new Error("uri is required");
      return (await conn!.get()).readResource({ uri: p.uri });
    },
  },
});

await plugin.run();
