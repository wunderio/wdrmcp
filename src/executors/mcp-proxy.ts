/**
 * MCP proxy executors — proxy tool calls to external MCP servers via HTTP.
 *
 * McpProxyExecutor: handles HTTP transport, auth, and remote tool discovery.
 * BoundRemoteToolExecutor: a thin wrapper that binds a specific remote tool
 *   name, so the registry doesn't need special-case logic for proxied tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { getLogger } from "../logger.js";
import McpValidator from "../validators/mcp-validator.js";
import {
  BaseToolConfigSchema,
  BaseExecutorOptions,
  BaseToolConfig,
} from "../types/base.js";

import type { ValidatorInterface } from "../types/validation.js";
import type {
  ExecutorConfig,
  RemoteToolDefinition,
  RemoteToolProvider,
  ToolExecutionResult,
  ToolExecutor,
} from "../types/types.js";

/**
 * YAML tool config schema for MCP proxy tools.
 */
export const McpProxyToolConfigSchema = z
  .object({
    ...BaseToolConfigSchema.shape,
    type: z.literal("mcp_server"),
    server_url: z.string(),
    tool_prefix: z.string().optional(),
    forward_args: z.boolean().optional(),
    auth_username: z.string().optional(),
    auth_password: z.string().optional(),
    auth_token: z.string().optional(),
    auth_token_basic: z.boolean().optional(),
    expose_remote_tools: z.boolean().optional(),
    init_timeout: z.number().int().positive().optional(),
  })
  .strict();

/** Configuration for an MCP server proxy tool. */
export interface McpProxyToolConfig extends BaseToolConfig {
  type: "mcp_server";
  server_url: string;
  tool_prefix?: string;
  forward_args?: boolean;
  timeout?: number;
  auth_username?: string;
  auth_password?: string;
  auth_token?: string;
  auth_token_basic?: boolean;
  expose_remote_tools?: boolean;
  init_timeout?: number;
}

export interface McpProxyExecutorOptions extends BaseExecutorOptions {
  serverUrl: string;
  forwardArgs?: boolean;
  timeout?: number;
  authUsername?: string;
  authPassword?: string;
  authToken?: string;
  authTokenBasic?: boolean;
}

export class McpProxyExecutor implements ToolExecutor, RemoteToolProvider {
  private readonly forwardArgs: boolean;
  private readonly headers: Record<string, string>;
  private readonly serverUrl: string;
  private readonly timeout: number;
  private readonly validator: ValidatorInterface;

  private client: Client | null = null;
  private connectPromise: Promise<void> | null = null;
  /** null = untried, true = SDK connected, false = fallback to raw fetch */
  private sdkAvailable: boolean | null = null;

  constructor(options: McpProxyExecutorOptions) {
    this.forwardArgs = options.forwardArgs ?? true;
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "wdrmcp/0.1",
    };
    this.serverUrl = options.serverUrl;
    this.timeout = (options.timeout ?? 10) * 1000;
    this.validator = new McpValidator(options);

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
   * Create a new instance of McpProxyExecutor from the provided configuration.
   *
   * @throws Error if required configuration is missing or invalid.
   */
  static create(
    executorConfig: ExecutorConfig<McpProxyToolConfig>,
  ): McpProxyExecutor {
    const {
      toolConfig: cfg,
      baseConfig,
      executor,
      resolvePlaceholders,
    } = executorConfig;
    const { name } = baseConfig;
    const log = getLogger();

    if (!cfg.server_url) {
      log.error(`Tool ${name}: missing server_url`);
      throw new Error(`Invalid configuration in ${name}: missing server_url`);
    }

    const authUsername = resolvePlaceholders("auth_username");
    const authPassword = resolvePlaceholders("auth_password");
    const authToken = resolvePlaceholders("auth_token");

    if (
      (cfg.auth_token && !cfg.auth_token.includes("${")) ||
      (cfg.auth_password && !cfg.auth_password.includes("${"))
    ) {
      log.warn(
        `Tool ${cfg.name}: auth credentials appear to be literal values; prefer environment variable placeholders`,
      );
    }

    return new McpProxyExecutor({
      ...baseConfig,
      serverUrl: cfg.server_url,
      forwardArgs: cfg.forward_args,
      timeout: cfg.timeout,
      authUsername,
      authPassword,
      authToken,
      authTokenBasic: cfg.auth_token_basic,
    });
  }

  getValidator(): ValidatorInterface {
    return this.validator;
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
        log.info(
          `Fetched ${tools.length} tools via SDK from ${this.serverUrl}`,
        );
        return tools;
      }

      // Fallback: raw JSON-RPC
      const result = await this.rawFetchRpc("tools/list", {});
      const tools = this.extractToolsFromRawResponse(result);
      log.info(
        `Fetched ${tools.length} tools via raw JSON-RPC from ${this.serverUrl}`,
      );
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
          const result = await this.client.callTool(
            {
              name: toolName,
              arguments: args,
            },
            undefined,
            { timeout: this.timeout },
          );
          return this.mapSdkResult(result);
        } catch (sdkError) {
          const msg = (sdkError as Error).message ?? "";
          if (
            msg.includes("output schema") ||
            msg.includes("structured content")
          ) {
            if (log.isVerbose()) {
              log.debug(
                `SDK outputSchema mismatch for ${toolName}, using raw JSON-RPC fallback`,
              );
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
        return {
          content: `Request timeout after ${this.timeout / 1000}s`,
          isError: true,
        };
      }
      log.error(`MCP proxy error: ${e}`);
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
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
  private async rawFetchRpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
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
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}${suffix}`,
        );
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
  private mapSdkResult(
    result: Awaited<ReturnType<Client["callTool"]>>,
  ): ToolExecutionResult {
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) {
      return {
        content: "",
        isError: result.isError === true ? true : undefined,
      };
    }

    const text = this.extractTextFromContentBlocks(content);
    return {
      content: text,
      isError: result.isError === true ? true : undefined,
    };
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
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      return {
        content: typeof result === "string" ? result : JSON.stringify(result),
      };
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
    const payload =
      "result" in r && typeof r.result === "object" && r.result !== null
        ? (r.result as Record<string, unknown>)
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
 * A thin wrapper that binds a specific remote tool name to a RemoteToolProvider.
 * This eliminates the need for the registry to track "originalName" separately.
 * Each remote tool gets its own BoundRemoteToolExecutor instance.
 *
 * NOTE: This class is special and doesn't implement static create().
 * Perhaps tracking "originalName" in the registry would be cleaner overall?
 */
export class BoundRemoteToolExecutor implements ToolExecutor {
  constructor(
    private readonly provider: RemoteToolProvider,
    private readonly remoteToolName: string,
  ) {}

  getValidator(): ValidatorInterface {
    return this.provider.getValidator();
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return this.provider.callTool(args, this.remoteToolName);
  }
}
