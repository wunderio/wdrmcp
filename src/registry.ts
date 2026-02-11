/**
 * ToolRegistry — loads tool definitions from YAML config files
 * and creates the appropriate executors.
 *
 * Refactored improvements:
 *  - BoundRemoteToolExecutor eliminates the originalName workaround
 *  - Path normalization is an arg preprocessor, not baked into executors
 *  - All tools go through a uniform execute path (no special-casing)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { globSync } from "glob";
import yaml from "js-yaml";
import { getLogger } from "./logger.js";
import { CommandToolExecutor } from "./executors/command.js";
import { McpProxyExecutor, BoundRemoteToolExecutor } from "./executors/mcp-proxy.js";
import type {
  BridgeConfig,
  ToolConfig,
  ToolsFileSchema,
  ToolExecutor,
  ToolExecutionResult,
  RegisteredTool,
  ArgPreprocessor,
  CommandToolConfig,
  McpServerToolConfig,
} from "./types.js";

export class ToolRegistry {
  private readonly toolsConfigDir: string;
  private readonly config: BridgeConfig;
  private readonly tools: Map<string, RegisteredTool> = new Map();
  private readonly argPreprocessor: ArgPreprocessor;

  constructor(toolsConfigDir: string, config: BridgeConfig) {
    this.toolsConfigDir = resolve(toolsConfigDir);
    this.config = config;

    // Path normalization as a composable preprocessor.
    // Converts devcontainer paths (e.g. /workspace/...) to container paths (/var/www/html/...).
    const hostRoot = config.hostProjectRoot;
    const containerRoot = config.containerProjectRoot;
    this.argPreprocessor = (args) => this.normalizePaths(args, hostRoot, containerRoot);
  }

  /**
   * Load all tools from YAML config files. Returns tool count.
   */
  async loadTools(): Promise<number> {
    const log = getLogger();

    if (!existsSync(this.toolsConfigDir)) {
      log.error(`Tools config directory not found: ${this.toolsConfigDir}`);
      return 0;
    }

    const configFiles = globSync("*.yml", { cwd: this.toolsConfigDir }).sort();
    let loadedCount = 0;

    for (const file of configFiles) {
      const filePath = join(this.toolsConfigDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const fileConfig = yaml.load(content) as ToolsFileSchema | null;

        if (!fileConfig) { log.warn(`Empty config file: ${file}`); continue; }
        if (!fileConfig.tools) { log.error(`Missing 'tools' array: ${file}`); continue; }

        for (const toolConfig of fileConfig.tools) {
          loadedCount += await this.loadSingleTool(toolConfig);
        }
      } catch (e) {
        log.error(`Error loading ${file}: ${e instanceof yaml.YAMLException ? e.message : e}`);
      }
    }

    log.info(`Loaded ${loadedCount} tools`);
    return loadedCount;
  }

  private async loadSingleTool(toolConfig: ToolConfig): Promise<number> {
    const log = getLogger();
    const name = toolConfig.name;

    if (!name) { log.warn("Tool config missing 'name'"); return 0; }
    if (toolConfig.enabled === false) { log.info(`Tool disabled: ${name}`); return 0; }

    const executor = this.createExecutor(toolConfig);
    if (!executor) { log.warn(`Failed to create executor: ${name}`); return 0; }

    // MCP server with expose_remote_tools: register each remote tool individually.
    if (toolConfig.type === "mcp_server" && (toolConfig as McpServerToolConfig).expose_remote_tools) {
      return this.loadRemoteMcpTools(toolConfig as McpServerToolConfig, executor as McpProxyExecutor);
    }

    this.tools.set(name, { config: toolConfig, executor });
    log.info(`Loaded tool: ${name}`);
    return 1;
  }

  /**
   * Fetch remote tools and register each with a BoundRemoteToolExecutor.
   * No "originalName" tracking needed — the binding is in the executor itself.
   */
  private async loadRemoteMcpTools(
    proxyConfig: McpServerToolConfig,
    proxy: McpProxyExecutor,
  ): Promise<number> {
    const log = getLogger();
    const proxyName = proxyConfig.name;
    log.info(`Fetching remote tools from: ${proxyName}`);

    try {
      const initTimeout = proxyConfig.init_timeout ?? 30;
      const remoteTools = await Promise.race([
        proxy.fetchRemoteTools(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${initTimeout}s`)), initTimeout * 1000),
        ),
      ]);

      if (!remoteTools?.length) { log.warn(`No tools from ${proxyName}`); return 0; }

      const prefix = proxyConfig.tool_prefix ?? "";
      let count = 0;

      for (const remote of remoteTools) {
        if (!remote.name) continue;

        const localName = prefix ? `${prefix}${remote.name}` : remote.name;

        // Each remote tool gets its own bound executor — no special-casing in executeTool().
        const boundExecutor = new BoundRemoteToolExecutor(proxy, remote.name);

        const wrappedConfig: McpServerToolConfig = {
          name: localName,
          description: remote.description ?? "",
          type: "mcp_server",
          input_schema: remote.inputSchema as ToolConfig["input_schema"],
          server_url: proxyConfig.server_url,
        };

        this.tools.set(localName, { config: wrappedConfig, executor: boundExecutor });
        log.info(`Loaded remote tool: ${localName} (from ${remote.name})`);
        count++;
      }

      log.info(`Loaded ${count} tools from ${proxyName}`);
      return count;
    } catch (e) {
      log.error(`Failed to load remote tools from ${proxyName}: ${e}`);
      return 0;
    }
  }

  private interpolateContainerName(container: string): string {
    return container?.includes("{DDEV_PROJECT}")
      ? container.replace(/\{DDEV_PROJECT\}/g, this.config.ddevProject)
      : container;
  }

  private createExecutor(toolConfig: ToolConfig): ToolExecutor | null {
    const log = getLogger();
    const type = toolConfig.type ?? "command";
    const name = toolConfig.name;

    try {
      if (type === "command") {
        const cfg = toolConfig as CommandToolConfig;
        if (!cfg.command_template) { log.error(`Tool ${name}: missing command_template`); return null; }

        return new CommandToolExecutor({
          commandTemplate: cfg.command_template,
          container: this.interpolateContainerName(cfg.container),
          ddevProject: this.config.ddevProject,
          user: cfg.user,
          shell: cfg.shell,
          defaultArgs: cfg.default_args,
          disallowedCommands: cfg.disallowed_commands,
          validationRules: cfg.validation_rules,
        });
      }

      if (type === "mcp_server") {
        const cfg = toolConfig as McpServerToolConfig;
        if (!cfg.server_url) { log.error(`Tool ${name}: missing server_url`); return null; }

        return new McpProxyExecutor({
          serverUrl: cfg.server_url,
          forwardArgs: cfg.forward_args,
          timeout: cfg.timeout,
          authUsername: cfg.auth_username,
          authPassword: cfg.auth_password,
          authToken: cfg.auth_token,
          authTokenBasic: cfg.auth_token_basic,
          verifySsl: cfg.verify_ssl,
        });
      }

      log.error(`Unknown tool type: ${type}`);
      return null;
    } catch (e) {
      log.error(`Error creating executor for ${name}: ${e}`);
      return null;
    }
  }

  // --- Public API ---

  getToolNames(): string[] { return [...this.tools.keys()]; }
  getTool(name: string): RegisteredTool | undefined { return this.tools.get(name); }
  getAllTools(): Map<string, RegisteredTool> { return this.tools; }

  /**
   * Execute a tool. Applies arg preprocessing (path normalization)
   * then delegates to the executor. No special-casing needed.
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const log = getLogger();
    const registered = this.tools.get(name);
    if (!registered) return { content: `Error: Unknown tool '${name}'`, isError: true };

    const { executor } = registered;

    try {
      executor.validateArguments(args);
    } catch (e) {
      return { content: `Validation error: ${(e as Error).message}`, isError: true };
    }

    // Apply preprocessor (path normalization).
    const processedArgs = this.argPreprocessor(args);

    try {
      return await executor.execute(processedArgs);
    } catch (e) {
      log.error(`Error executing ${name}: ${e}`);
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  }

  /**
   * Recursively normalize devcontainer paths to container paths in argument values.
   */
  private normalizePaths(
    value: Record<string, unknown>,
    hostRoot: string,
    containerRoot: string,
  ): Record<string, unknown> {
    const normalize = (v: unknown): unknown => {
      if (typeof v === "string") {
        return v.startsWith(hostRoot + "/")
          ? containerRoot + v.slice(hostRoot.length)
          : v;
      }
      if (Array.isArray(v)) return v.map(normalize);
      if (v !== null && typeof v === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) result[k] = normalize(val);
        return result;
      }
      return v;
    };

    return normalize(value) as Record<string, unknown>;
  }
}
