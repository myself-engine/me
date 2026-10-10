// Thin MCP client used by the bridge: connects to one MCP server over stdio and reconnects on demand.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class McpConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private config: McpServerConfig,
    private name = "me-mcp-bridge",
  ) {}

  async get(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) },
      cwd: this.config.cwd,
      stderr: "inherit",
    });
    const client = new Client({ name: this.name, version: "0.1.0" });
    transport.onclose = () => {
      if (this.client === client) this.client = null;
    };
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}
