/**
 * MCP stdio executor — launches a remote MCP server as an SSH subprocess
 * and communicates via stdin/stdout using the MCP SDK's StdioClientTransport.
 *
 * Eliminates the need for HTTP endpoints, OAuth tokens, and SSL — SSH trust
 * is already configured in the DDEV environment.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { getLogger } from "../logger.js";
import { buildSshArgs, buildDdevEnvPrelude } from "../ssh-utils.js";
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
 * YAML tool config schema for MCP stdio transport tools.
 */
export const McpStdioToolConfigSchema = z
  .object({
    ...BaseToolConfigSchema.shape,
    type: z.literal("mcp_stdio"),
    command: z.string(),
    ssh_target: z.string().optional(),
    ssh_user: z.string().optional(),
    working_dir: z.string().optional(),
    expose_remote_tools: z.boolean().optional(),
    tool_prefix: z.string().optional(),
    init_timeout: z.number().int().positive().optional(),
  })
  .strict();

/** Configuration for an MCP stdio transport tool. */
export interface McpStdioToolConfig extends BaseToolConfig {
  type: "mcp_stdio";
  command: string;
  ssh_target?: string;
  ssh_user?: string;
  working_dir?: string;
  expose_remote_tools?: boolean;
  tool_prefix?: string;
  init_timeout?: number;
  timeout?: number;
}

export interface McpStdioExecutorOptions extends BaseExecutorOptions {
  /** Remote command to run (e.g. "vendor/bin/drush mcp:server"). */
  command: string;
  /** SSH host (e.g. "web"). If omitted, command runs locally. */
  sshTarget?: string;
  /** SSH user for remote connection. */
  sshUser?: string;
  /** Project root directory on the remote. */
  projectRootDir?: string;
  /** Remote working directory. */
  workingDir?: string;
  /** Seconds for initialize handshake (default 30). */
  initTimeout?: number;
  /** Per-call timeout in seconds (default 60). */
  timeout?: number;
  /** Enforce SSH host key validation. */
  strictHostKeyChecking?: boolean;
}

export class McpStdioExecutor implements ToolExecutor, RemoteToolProvider {
  private readonly command: string;
  private readonly initTimeout: number;
  private readonly projectRootDir: string;
  private readonly sshTarget?: string;
  private readonly sshUser?: string;
  private readonly strictHostKeyChecking: boolean;
  private readonly timeout: number;
  private readonly validator: ValidatorInterface;
  private readonly workingDir?: string;

  private client: Client | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private disconnected = false;
  private reconnectAttempted = false;
  private transport: StdioClientTransport | null = null;

  constructor(options: McpStdioExecutorOptions) {
    this.command = options.command;
    this.initTimeout = (options.initTimeout ?? 30) * 1000;
    this.projectRootDir = options.projectRootDir ?? "/var/www/html";
    this.sshTarget = options.sshTarget;
    this.sshUser = options.sshUser;
    this.strictHostKeyChecking = options.strictHostKeyChecking ?? false;
    this.timeout = (options.timeout ?? 60) * 1000;
    this.validator = new McpValidator(options);
    this.workingDir = options.workingDir;
  }

  /**
   * Create a new instance of McpStdioExecutor from the provided configuration.
   *
   * @throws Error if required configuration is missing or invalid.
   */
  static create(
    executorConfig: ExecutorConfig<McpStdioToolConfig>,
  ): McpStdioExecutor {
    const {
      toolConfig: cfg,
      baseConfig,
      bridgeConfig,
      resolvePlaceholders,
    } = executorConfig;
    const { name } = baseConfig;
    const log = getLogger();

    if (!cfg.command) {
      log.error(`Tool ${name}: missing command`);
      throw new Error(`Invalid MCP stdio tool config: missing command`);
    }

    const sshTarget = resolvePlaceholders("ssh_target");
    const sshUser = resolvePlaceholders("ssh_user");
    const workingDir = resolvePlaceholders("working_dir");

    const executor = new McpStdioExecutor({
      ...baseConfig,
      command: cfg.command,
      sshTarget,
      sshUser,
      workingDir,
      initTimeout: cfg.init_timeout,
      timeout: cfg.timeout,
      strictHostKeyChecking: bridgeConfig.strictHostKeyChecking,
    });
    return executor;
  }

  getValidator(): ValidatorInterface {
    return this.validator;
  }

  async fetchRemoteTools(): Promise<RemoteToolDefinition[]> {
    const log = getLogger();
    const target = this.sshTarget ?? "local";
    log.info(`Fetching remote tools via stdio from ${target}`);
    if (log.isVerbose()) {
      log.debug(`MCP stdio command: ${this.command}`);
    }

    try {
      await this.ensureConnected();

      if (!this.client) {
        return [];
      }

      const result = await this.client.listTools();
      const tools: RemoteToolDefinition[] = result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));

      log.info(`Fetched ${tools.length} tools via stdio from ${target}`);
      return tools;
    } catch (e) {
      log.error(`Failed to fetch tools via stdio from ${target}: ${e}`);
      return [];
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return this.callTool(args);
  }

  async callTool(
    args: Record<string, unknown>,
    toolName?: string,
  ): Promise<ToolExecutionResult> {
    const log = getLogger();

    try {
      await this.ensureConnected();

      if (!this.client) {
        return {
          content: "Error: MCP stdio client not connected",
          isError: true,
        };
      }

      const name = toolName ?? "unknown";
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.timeout },
      );

      return this.mapSdkResult(result);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return {
          content: `Request timeout after ${this.timeout / 1000}s`,
          isError: true,
        };
      }
      log.error(`MCP stdio call error: ${e}`);
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  }

  /** Close the MCP client and kill the SSH subprocess. */
  async close(): Promise<void> {
    const log = getLogger();
    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
      }
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }
      this.connected = false;
      this.disconnected = true;
      log.info("MCP stdio connection closed");
    } catch (e) {
      log.debug(`Error closing MCP stdio connection: ${e}`);
    }
  }

  private async ensureConnected(): Promise<void> {
    // Already connected and not disconnected — nothing to do.
    if (this.connected && !this.disconnected) {
      return;
    }

    // Was connected but transport closed — attempt one reconnect.
    if (this.connected && this.disconnected) {
      if (this.reconnectAttempted) {
        throw new Error("MCP stdio reconnect already failed");
      }
      this.reconnectAttempted = true;
      const log = getLogger();
      log.info("MCP stdio transport disconnected, attempting reconnect...");
      this.connected = false;
      this.disconnected = false;
      this.client = null;
      this.transport = null;
    }

    // Deduplicate concurrent connection attempts.
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
    const target = this.sshTarget ?? "local";

    try {
      let transportCommand: string;
      let transportArgs: string[];

      if (this.sshTarget) {
        // Remote: run command via SSH
        let remoteCmd = this.command;
        if (this.workingDir) {
          remoteCmd = `cd ${this.workingDir} && ${remoteCmd}`;
        }

        // SSH sessions don't inherit container env vars — prepend the DDEV
        // env prelude so Drush can connect to the database and bootstrap.
        const envPrelude = buildDdevEnvPrelude(this.projectRootDir);
        if (envPrelude) {
          remoteCmd = `${envPrelude}${remoteCmd}`;
        }

        const sshArgs = buildSshArgs({
          host: this.sshTarget,
          user: this.sshUser,
          strictHostKeyChecking: this.strictHostKeyChecking,
        });
        sshArgs.push(remoteCmd);

        transportCommand = "ssh";
        transportArgs = sshArgs;
      } else {
        // Local: run command directly
        const parts = this.command.split(/\s+/);
        transportCommand = parts[0];
        transportArgs = parts.slice(1);
      }

      if (log.isVerbose()) {
        log.debug(
          `MCP stdio: spawning ${transportCommand} ${transportArgs.join(" ")}`,
        );
      }

      const transport = new StdioClientTransport({
        command: transportCommand,
        args: transportArgs,
        stderr: "pipe",
      });

      // Log stderr from the subprocess for debugging (can be noisy).
      transport.stderr?.on("data", (data: Buffer) => {
        if (log.isVerbose()) {
          const msg = data.toString().trim();
          if (msg) {
            log.debug(`MCP stdio stderr [${target}]: ${msg}`);
          }
        }
      });

      const client = new Client(
        { name: "wdrmcp", version: "0.1" },
        { capabilities: {} },
      );

      // Initialize with timeout.
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Initialize timeout after ${this.initTimeout / 1000}s`,
                ),
              ),
            this.initTimeout,
          ),
        ),
      ]);

      // Track disconnection.
      transport.onclose = () => {
        this.disconnected = true;
        log.info(`MCP stdio transport closed [${target}]`);
      };

      this.client = client;
      this.transport = transport;
      this.connected = true;
      this.disconnected = false;
      this.reconnectAttempted = false;

      if (log.isVerbose()) {
        const serverInfo = client.getServerVersion();
        log.debug(
          `MCP stdio connected to ${target}${serverInfo ? ` (${serverInfo.name} ${serverInfo.version})` : ""}`,
        );
      }
    } catch (e) {
      log.error(`MCP stdio connect failed for ${target}: ${e}`);
      throw e;
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

    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      } else {
        texts.push(JSON.stringify(b));
      }
    }

    return {
      content: texts.join("\n"),
      isError: result.isError === true ? true : undefined,
    };
  }
}
