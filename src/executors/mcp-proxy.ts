/**
 * MCP proxy executors — proxy tool calls to external MCP servers via HTTP.
 *
 * McpProxyExecutor: handles HTTP transport, auth, and remote tool discovery.
 * BoundRemoteToolExecutor: a thin wrapper that binds a specific remote tool
 *   name, so the registry doesn't need special-case logic for proxied tools.
 */

import { getLogger } from "../logger.js";
import type { ToolExecutionResult, ToolExecutor } from "../types.js";

/** Remote tool definition as returned by tools/list. */
export interface RemoteToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpProxyOptions {
  serverUrl: string;
  forwardArgs?: boolean;
  timeout?: number;
  authUsername?: string;
  authPassword?: string;
  authToken?: string;
  authTokenBasic?: boolean;
  verifySsl?: boolean;
}

export class McpProxyExecutor implements ToolExecutor {
  private readonly serverUrl: string;
  private readonly forwardArgs: boolean;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;

  constructor(options: McpProxyOptions) {
    this.serverUrl = options.serverUrl;
    this.forwardArgs = options.forwardArgs ?? true;
    this.timeout = (options.timeout ?? 10) * 1000;
    this.headers = { "Content-Type": "application/json" };

    if (options.authToken) {
      if (options.authTokenBasic) {
        const encoded = Buffer.from(options.authToken).toString("base64");
        this.headers["Authorization"] = `Basic ${encoded}`;
      } else {
        this.headers["Authorization"] = `Bearer ${options.authToken}`;
      }
    } else if (options.authUsername && options.authPassword) {
      const encoded = Buffer.from(
        `${options.authUsername}:${options.authPassword}`,
      ).toString("base64");
      this.headers["Authorization"] = `Basic ${encoded}`;
    }
  }

  /** Fetch available tools from the remote MCP server via tools/list. */
  async fetchRemoteTools(): Promise<RemoteToolDefinition[]> {
    const log = getLogger();
    log.info(`Fetching remote tools from ${this.serverUrl}`);

    try {
      const result = await this.rpc("tools/list", {});

      let tools: RemoteToolDefinition[];
      if (Array.isArray(result)) {
        tools = result;
      } else if (typeof result === "object" && result !== null) {
        const r = result as Record<string, unknown>;
        const raw = r.tools ?? (r.result as Record<string, unknown>)?.tools ?? [];
        tools = (Array.isArray(raw) ? raw : []) as RemoteToolDefinition[];
      } else {
        log.warn(`Unexpected response format from ${this.serverUrl}`);
        return [];
      }

      log.info(`Fetched ${tools.length} tools from ${this.serverUrl}`);
      return tools;
    } catch (e) {
      log.error(`Failed to fetch tools from ${this.serverUrl}: ${e}`);
      return [];
    }
  }

  /** Execute a direct (non-proxied) tool call. */
  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return this.callTool(args);
  }

  /**
   * Call a specific tool on the remote MCP server by name.
   * Used by BoundRemoteToolExecutor.
   */
  async callTool(
    args: Record<string, unknown>,
    toolName?: string,
  ): Promise<ToolExecutionResult> {
    try {
      let payload: Record<string, unknown>;
      if (toolName) {
        payload = { method: "tools/call", params: { name: toolName, arguments: args } };
      } else if (typeof args.method === "string") {
        payload = { method: args.method, params: (args.params as Record<string, unknown>) ?? {} };
      } else {
        payload = this.forwardArgs ? args : {};
      }

      const result = await this.rpc(
        payload.method as string,
        payload.params as Record<string, unknown>,
      );

      return this.parseResponse(result);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return { content: `Request timeout after ${this.timeout / 1000}s`, isError: true };
      }
      getLogger().error(`MCP proxy error: ${e}`);
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  }

  validateArguments(_args: Record<string, unknown>): void {
    // Remote servers handle their own validation.
  }

  /** Send a JSON-RPC request to the remote server. */
  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.serverUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse a JSON-RPC response into a ToolExecutionResult. */
  private parseResponse(result: unknown): ToolExecutionResult {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return { content: typeof result === "string" ? result : JSON.stringify(result) };
    }

    const r = result as Record<string, unknown>;
    if ("result" in r) return { content: String(r.result) };

    const content = r.content;
    if (Array.isArray(content) && content.length > 0) {
      return { content: (content[0] as Record<string, unknown>).text as string ?? JSON.stringify(result) };
    }

    if ("error" in r) {
      const err = r.error as Record<string, unknown>;
      return { content: `RPC Error: ${err.message ?? String(err)}`, isError: true };
    }

    return { content: JSON.stringify(result) };
  }
}

/**
 * A thin wrapper that binds a specific remote tool name to a McpProxyExecutor.
 * This eliminates the need for the registry to track "originalName" separately.
 * Each remote tool gets its own BoundRemoteToolExecutor instance.
 */
export class BoundRemoteToolExecutor implements ToolExecutor {
  constructor(
    private readonly proxy: McpProxyExecutor,
    private readonly remoteToolName: string,
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return this.proxy.callTool(args, this.remoteToolName);
  }

  validateArguments(_args: Record<string, unknown>): void {
    // Remote server handles validation.
  }
}
