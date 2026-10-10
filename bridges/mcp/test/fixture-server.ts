// Minimal MCP server used by the bridge test: one tool, one resource.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "0.0.1" });
server.tool("add", "Add two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));
server.resource("greeting", "fixture://greeting", async (uri) => ({
  contents: [{ uri: uri.href, text: "hello from fixture" }],
}));
await server.connect(new StdioServerTransport());
