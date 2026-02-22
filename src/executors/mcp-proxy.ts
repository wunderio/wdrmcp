/**
 * MCP proxy executors — proxy tool calls to external MCP servers via HTTP.
 *
 * McpProxyExecutor: handles HTTP transport, auth, and remote tool discovery.
 * BoundRemoteToolExecutor: a thin wrapper that binds a specific remote tool
 *   name, so the registry doesn't need special-case logic for proxied tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
}

export class McpProxyExecutor implements ToolExecutor {
  private readonly serverUrl: string;
  private readonly forwardArgs: boolean;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;
  private client: Client | null = null;
  /** null = untried, true = SDK connected, false = fallback to raw fetch */
  private sdkAvailable: boolean | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(options: McpProxyOptions) {
    this.serverUrl = options.serverUrl;
    this.forwardArgs = options.forwardArgs ?? true;
    this.timeout = (options.timeout ?? 10) * 1000;
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "wdrmcp/0.1",
    };

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

  /**
   * Fetch available tools from the remote MCP server via tools/list.
   *
   * Uses client.listTools() when the SDK is connected (required for servers
   * that need the initialize handshake). Falls back to raw JSON-RPC otherwise.
   * Note: client.listTools() caches outputSchema validators which may cause
   * callTool() to reject valid responses from servers that return content
   * instead of structuredContent — callTool() handles this with a retry.
   */
  async fetchRemoteTools(): Promise<RemoteToolDefinition[]> {
    const log = getLogger();
    log.info(`Fetching remote tools from ${this.serverUrl}`);

    try {
      await this.ensureConnected();

      if (this.sdkAvailable && this.client) {
        const result = await this.client.listTools();
        const tools: RemoteToolDefinition[] = result.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));
        log.info(`Fetched ${tools.length} tools via SDK from ${this.serverUrl}`);
        return tools;
      }

      // Fallback: raw JSON-RPC
      const result = await this.rawFetchRpc("tools/list", {});
      const tools = this.extractToolsFromRawResponse(result);
      log.info(`Fetched ${tools.length} tools via raw JSON-RPC from ${this.serverUrl}`);
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
    const log = getLogger();

    try {
      await this.ensureConnected();

      // SDK path: use client.callTool for named tool calls.
      // Falls back to raw JSON-RPC on outputSchema validation errors
      // (some servers declare outputSchema but return content instead of structuredContent).
      if (this.sdkAvailable && this.client && toolName) {
        try {
          const result = await this.client.callTool({
            name: toolName,
            arguments: args,
          }, undefined, { timeout: this.timeout });
          return this.mapSdkResult(result);
        } catch (sdkError) {
          const msg = (sdkError as Error).message ?? "";
          if (msg.includes("output schema") || msg.includes("structured content")) {
            if (log.isVerbose()) {
              log.debug(`SDK outputSchema mismatch for ${toolName}, using raw JSON-RPC fallback`);
            }
          } else {
            throw sdkError;
          }
        }
      }

      // Fallback: raw JSON-RPC
      let method: string;
      let params: Record<string, unknown>;

      if (toolName) {
        method = "tools/call";
        params = { name: toolName, arguments: args };
      } else if (typeof args.method === "string") {
        method = args.method;
        params = (args.params as Record<string, unknown>) ?? {};
      } else {
        method = "tools/call";
        params = this.forwardArgs ? args : {};
      }

      const result = await this.rawFetchRpc(method, params);
      return this.parseRawResponse(result);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return { content: `Request timeout after ${this.timeout / 1000}s`, isError: true };
      }
      log.error(`MCP proxy error: ${e}`);
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  }

  validateArguments(_args: Record<string, unknown>): void {
    // Remote servers handle their own validation.
  }

  /**
   * Lazily connect to the remote server via MCP SDK.
   * On failure, sets sdkAvailable=false so callers fall back to raw fetch.
   * Deduplicates concurrent connection attempts.
   */
  private async ensureConnected(): Promise<void> {
    if (this.sdkAvailable !== null) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    const log = getLogger();

    try {
      const { Authorization, ...rest } = this.headers;
      const requestHeaders: Record<string, string> = { ...rest };
      if (Authorization) {
        requestHeaders["Authorization"] = Authorization;
      }

      const transport = new StreamableHTTPClientTransport(
        new URL(this.serverUrl),
        {
          requestInit: {
            headers: requestHeaders,
          },
        },
      );

      const client = new Client(
        { name: "wdrmcp", version: "0.1" },
        { capabilities: {} },
      );

      await client.connect(transport);

      this.client = client;
      this.sdkAvailable = true;

      if (log.isVerbose()) {
        const serverInfo = client.getServerVersion();
        log.debug(
          `Connected to MCP server at ${this.serverUrl}${serverInfo ? ` (${serverInfo.name} ${serverInfo.version})` : ""}`,
        );
      }
    } catch (e) {
      this.sdkAvailable = false;
      if (log.isVerbose()) {
        log.debug(
          `MCP SDK connect failed for ${this.serverUrl}; falling back to raw JSON-RPC: ${e}`,
        );
      }
    }
  }

  /**
   * Simplified fallback for non-MCP servers: plain JSON-RPC 2.0 POST.
   * No session tracking, no SSE parsing, no notifications.
   */
  private async rawFetchRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const payload = {
        jsonrpc: "2.0",
        method,
        params,
        id: 1,
      };

      const response = await fetch(this.serverUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const compactError = errorText.replace(/\s+/g, " ").trim();
        const suffix = compactError ? ` - ${compactError}` : "";
        throw new Error(`HTTP ${response.status}: ${response.statusText}${suffix}`);
      }

      const raw = await response.text();
      if (!raw) {
        return {};
      }

      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map SDK CallToolResult to project's ToolExecutionResult. */
  private mapSdkResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolExecutionResult {
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) {
      return { content: "", isError: result.isError === true ? true : undefined };
    }

    const text = this.extractTextFromContentBlocks(content);
    return { content: text, isError: result.isError === true ? true : undefined };
  }

  /** Extract tool definitions from a raw JSON-RPC response. */
  private extractToolsFromRawResponse(result: unknown): RemoteToolDefinition[] {
    if (Array.isArray(result)) {
      return result as RemoteToolDefinition[];
    }

    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const raw = r.tools ?? (r.result as Record<string, unknown>)?.tools ?? [];
      return (Array.isArray(raw) ? raw : []) as RemoteToolDefinition[];
    }

    getLogger().warn(`Unexpected response format from ${this.serverUrl}`);
    return [];
  }

  /** Parse a raw JSON-RPC response into a ToolExecutionResult. */
  private parseRawResponse(result: unknown): ToolExecutionResult {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return { content: typeof result === "string" ? result : JSON.stringify(result) };
    }

    const r = result as Record<string, unknown>;

    // Handle JSON-RPC error field
    if ("error" in r) {
      const err = r.error as Record<string, unknown>;
      const message = err.message ?? String(err);
      return { content: String(message), isError: true };
    }

    // Unwrap JSON-RPC result envelope: {"jsonrpc":"2.0","result":{...},"id":1}
    // The actual MCP response is inside r.result.
    const payload = ("result" in r && typeof r.result === "object" && r.result !== null)
      ? r.result as Record<string, unknown>
      : r;

    // Handle MCP-style content array
    const content = payload.content;
    if (Array.isArray(content) && content.length > 0) {
      const text = this.extractTextFromContentBlocks(content);
      const isError = payload.isError === true ? true : undefined;
      return { content: text, isError };
    }

    // Handle plain result (string or object)
    if ("result" in r) {
      const res = r.result;
      return { content: typeof res === "string" ? res : JSON.stringify(res) };
    }

    // Fallback: return raw data as-is
    return { content: JSON.stringify(result) };
  }

  /**
   * Extract clean text from MCP content blocks, unwrapping nested structures.
   *
   * Some MCP servers (e.g. n8n) wrap upstream API responses as JSON-encoded
   * content blocks inside their own content blocks:
   *   content[0].text = '[{"content":[{"type":"text","text":"# Actual markdown..."}]}]'
   *
   * This method detects and unwraps such nesting to return clean text.
   */
  private extractTextFromContentBlocks(blocks: unknown[]): string {
    const texts: string[] = [];
    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      } else {
        texts.push(JSON.stringify(b));
      }
    }

    let text = texts.join("\n");

    // Try to unwrap nested content structures.
    try {
      const parsed = JSON.parse(text);

      // Plain string (JSON-escaped): '"some text"' → 'some text'
      if (typeof parsed === "string") {
        return parsed;
      }

      // Nested content blocks array:
      // [{"content":[{"type":"text","text":"..."}]}]
      if (Array.isArray(parsed)) {
        const innerTexts: string[] = [];
        for (const item of parsed) {
          if (item?.content && Array.isArray(item.content)) {
            for (const inner of item.content) {
              if (inner?.type === "text" && typeof inner?.text === "string") {
                innerTexts.push(inner.text);
              }
            }
          }
        }
        if (innerTexts.length > 0) {
          return innerTexts.join("\n");
        }
      }

      // Nested single content object: {"content":[{"type":"text","text":"..."}]}
      if (parsed?.content && Array.isArray(parsed.content)) {
        const innerTexts: string[] = [];
        for (const inner of parsed.content) {
          if (inner?.type === "text" && typeof inner?.text === "string") {
            innerTexts.push(inner.text);
          }
        }
        if (innerTexts.length > 0) {
          return innerTexts.join("\n");
        }
      }
    } catch {
      // Not JSON, use as-is
    }

    return text;
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
