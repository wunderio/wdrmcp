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
import { z } from "zod";
import { getLogger } from "./logger.js";
import {
  resolveEnvVars,
  ensureNoUnresolvedEnvPlaceholders,
} from "./env-resolve.js";

import {
  CommandToolConfigSchema,
  CommandToolConfig,
  CommandToolExecutor,
} from "./executors/command.js";
import {
  CheckToolConfigSchema,
  CheckToolConfig,
  CheckToolExecutor,
} from "./executors/check.js";
import {
  BoundRemoteToolExecutor,
  McpProxyExecutor,
  McpProxyToolConfig,
  McpProxyToolConfigSchema,
} from "./executors/mcp-proxy.js";
import {
  McpStdioExecutor,
  McpStdioToolConfig,
  McpStdioToolConfigSchema,
} from "./executors/mcp-stdio.js";

import type { Args, EnvVars, BridgeVars } from "./types/args.js";
import type {
  ArgPreprocessor,
  BridgeConfig,
  ExecutorConfig,
  RegisteredTool,
  RemoteToolProvider,
  ToolConfig,
  ToolExecutionResult,
  ToolExecutor,
  ToolsFileSchema,
} from "./types/types.js";

const ToolConfigSchema = z.discriminatedUnion("type", [
  CommandToolConfigSchema,
  CheckToolConfigSchema,
  McpProxyToolConfigSchema,
  McpStdioToolConfigSchema,
]);

const ToolsFileSchemaValidator = z
  .object({
    tools: z.array(ToolConfigSchema),
  })
  .strict();

export class ToolRegistry {
  private readonly toolsConfigDir: string;
  private readonly config: BridgeConfig;
  private readonly tools: Map<string, RegisteredTool> = new Map();
  private readonly argPreprocessor: ArgPreprocessor;
  private readonly stdioExecutors: McpStdioExecutor[] = [];

  constructor(toolsConfigDir: string, config: BridgeConfig) {
    this.toolsConfigDir = resolve(toolsConfigDir);
    this.config = config;

    // Path normalization as a composable preprocessor.
    // Converts devcontainer paths (e.g. /workspace/...) to container paths (/var/www/html/...).
    const hostRoot = config.hostProjectRoot;
    const containerRoot = config.containerProjectRoot;
    this.argPreprocessor = (args) =>
      this.normalizePaths(args, hostRoot, containerRoot);
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

    log.info(`Loading tools from: ${this.toolsConfigDir}`);
    const configFiles = globSync("*.yml", { cwd: this.toolsConfigDir }).sort();

    if (configFiles.length === 0) {
      log.warn(`No .yml files found in ${this.toolsConfigDir}`);
    }

    if (log.isVerbose()) {
      log.debug(`Found config files: ${configFiles.join(", ")}`);
    }
    let loadedCount = 0;

    for (const file of configFiles) {
      const filePath = join(this.toolsConfigDir, file);
      try {
        if (log.isVerbose()) {
          log.debug(`Loading config file: ${file}`);
        }
        const content = readFileSync(filePath, "utf-8");
        const parsed = yaml.load(content);

        if (!parsed) {
          log.warn(`Empty config file: ${file}`);
          continue;
        }

        const validation = ToolsFileSchemaValidator.safeParse(parsed);
        if (!validation.success) {
          const details = validation.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
            )
            .join("; ");
          log.error(`Invalid config schema in ${file}: ${details}`);
          continue;
        }

        const fileConfig = validation.data as ToolsFileSchema;

        if (log.isVerbose()) {
          log.debug(`Found ${fileConfig.tools.length} tools in ${file}`);
        }
        for (const toolConfig of fileConfig.tools) {
          loadedCount += await this.loadSingleTool(toolConfig);
        }
      } catch (e) {
        log.error(
          `Error loading ${file}: ${e instanceof yaml.YAMLException ? e.message : e}`,
        );
      }
    }

    log.info(`Loaded ${loadedCount} tools total`);
    return loadedCount;
  }

  private async loadSingleTool(toolConfig: ToolConfig): Promise<number> {
    const log = getLogger();
    const name = toolConfig.name;

    if (!name) {
      log.warn("Tool config missing 'name'");
      return 0;
    }
    if (toolConfig.enabled === false) {
      log.info(`Tool disabled: ${name}`);
      return 0;
    }

    const executor = this.createExecutor(toolConfig);
    if (!executor) {
      log.warn(`Failed to create executor: ${name}`);
      return 0;
    }

    // MCP server/stdio with expose_remote_tools: register each remote tool individually.
    if (
      toolConfig.type === "mcp_server" &&
      (toolConfig as McpProxyToolConfig).expose_remote_tools
    ) {
      return this.loadRemoteMcpTools(
        toolConfig as McpProxyToolConfig,
        executor as McpProxyExecutor,
      );
    }
    if (
      toolConfig.type === "mcp_stdio" &&
      (toolConfig as McpStdioToolConfig).expose_remote_tools
    ) {
      return this.loadRemoteMcpTools(
        toolConfig as McpStdioToolConfig,
        executor as McpStdioExecutor,
      );
    }

    this.tools.set(name, { config: toolConfig, executor });
    log.info(`Loaded tool: ${name}`);
    return 1;
  }

  /**
   * Fetch remote tools and register each with a BoundRemoteToolExecutor.
   * No "originalName" tracking needed — the binding is in the executor itself.
   * Works with any RemoteToolProvider (McpProxyExecutor or McpStdioExecutor).
   */
  private async loadRemoteMcpTools(
    providerConfig: McpProxyToolConfig | McpStdioToolConfig,
    provider: RemoteToolProvider,
  ): Promise<number> {
    const log = getLogger();
    const providerName = providerConfig.name;
    log.info(`Fetching remote tools from: ${providerName}`);

    try {
      const initTimeout = providerConfig.init_timeout ?? 30;
      const remoteTools = await Promise.race([
        provider.fetchRemoteTools(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout after ${initTimeout}s`)),
            initTimeout * 1000,
          ),
        ),
      ]);

      if (!remoteTools?.length) {
        log.warn(`No tools from ${providerName}`);
        return 0;
      }

      const prefix = providerConfig.tool_prefix ?? `${providerName}_`;
      let count = 0;

      for (const remote of remoteTools) {
        if (!remote.name) continue;

        const localName = `${prefix}${remote.name}`;

        // Each remote tool gets its own bound executor — no special-casing in executeTool().
        const boundExecutor = new BoundRemoteToolExecutor(
          provider,
          remote.name,
        );

        const wrappedConfig: ToolConfig = {
          ...providerConfig,
          name: localName,
          description: remote.description ?? "",
          input_schema: remote.inputSchema as ToolConfig["input_schema"],
        };

        this.tools.set(localName, {
          config: wrappedConfig,
          executor: boundExecutor,
        });
        log.info(`Loaded remote tool: ${localName} (from ${remote.name})`);
        count++;
      }

      log.info(`Loaded ${count} tools from ${providerName}`);
      return count;
    } catch (e) {
      log.error(`Failed to load remote tools from ${providerName}: ${e}`);
      return 0;
    }
  }

  /**
   * Create a resolver function which handles resolving env and bridge vars,
   * and ensures there are no unresolved placeholders.
   */
  private createPlaceholderResolver(
    toolName: string,
    cfg: ToolConfig,
    envVars: EnvVars,
    bridgeVars: BridgeVars,
  ) {
    /**
     * Resolves env and bridge vars in the value of the given property.
     * Ensures that no placeholders are left in the value.
     *
     * @throws Error if the property is not a string,
     *   or if there are unresolved placeholders after resolution.
     */
    return function resolvePlaceholders(
      propertyName: keyof ToolConfig,
    ): string | undefined {
      const target = cfg[propertyName];
      // Loose check for null/undefined.
      if (target == null) {
        return undefined;
      }
      // Resolve vars in strings.
      if (typeof target === "string") {
        const resolved = resolveEnvVars(target, envVars, bridgeVars);
        ensureNoUnresolvedEnvPlaceholders(resolved, toolName, propertyName);
        return resolved;
      }
      throw new Error(
        `Tool ${toolName}: resolvePlaceholders() can only be used on strings; property '${String(propertyName)}' is of type '${typeof target}'`,
      );
    };
  }

  private getBaseConfig(toolConfig: ToolConfig) {
    const {
      name,
      enabled,
      description,
      type,
      input_schema: inputSchema,
      disallowed_commands: disallowedCommands,
      max_arg_length: maxArgLength,
      validation_rules: validationRules,
    } = toolConfig;

    return {
      name,
      enabled,
      description,
      type,
      inputSchema,
      disallowedCommands,
      maxArgLength,
      validationRules,
    };
  }

  private createExecutor(toolConfig: ToolConfig): ToolExecutor | null {
    const log = getLogger();
    const type = toolConfig.type ?? "command";
    const name = toolConfig.name;

    // Resolve environment variables and bridge placeholders
    const envVars = {
      ...(process.env as Record<string, string | undefined>),
      DDEV_SSH_USER: process.env.DDEV_SSH_USER ?? this.config.sshUser,
    };
    const bridgeVars = { DDEV_PROJECT: this.config.ddevProject };
    const baseConfig = this.getBaseConfig(toolConfig);

    const resolvePlaceholders = this.createPlaceholderResolver(
      name,
      toolConfig,
      envVars,
      bridgeVars,
    );

    const executorConfig = {
      toolConfig,
      baseConfig,
      bridgeConfig: this.config,
      resolvePlaceholders,
    };

    try {
      if (type === "command") {
        return CommandToolExecutor.create(
          executorConfig as ExecutorConfig<CommandToolConfig>,
        );
      }

      if (type === "check") {
        return CheckToolExecutor.create(
          executorConfig as ExecutorConfig<CheckToolConfig>,
        );
      }

      if (type === "mcp_server") {
        return McpProxyExecutor.create(
          executorConfig as ExecutorConfig<McpProxyToolConfig>,
        );
      }

      if (type === "mcp_stdio") {
        const executor = McpStdioExecutor.create(
          executorConfig as ExecutorConfig<McpStdioToolConfig>,
        );
        this.stdioExecutors.push(executor);
        return executor;
      }

      log.error(`Unknown tool type: ${type}`);
      return null;
    } catch (e) {
      log.error(`Error creating executor for ${name}: ${e}`);
      return null;
    }
  }

  // --- Public API ---

  getToolNames(): string[] {
    return [...this.tools.keys()];
  }
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
  getAllTools(): Map<string, RegisteredTool> {
    return this.tools;
  }

  /** Close all stdio executors (kills SSH subprocesses). */
  async close(): Promise<void> {
    const log = getLogger();
    for (const executor of this.stdioExecutors) {
      try {
        await executor.close();
      } catch (e) {
        log.debug(`Error closing stdio executor: ${e}`);
      }
    }
  }

  /**
   * Execute a tool. Applies arg preprocessing (path normalization)
   * then delegates to the executor. No special-casing needed.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const log = getLogger();
    const registered = this.tools.get(name);
    if (!registered) {
      log.warn(`Tool not found: ${name}`);
      return { content: `Error: Unknown tool '${name}'`, isError: true };
    }

    const { executor, config } = registered;
    if (log.isVerbose()) {
      log.debug(`Tool executor type: ${executor.constructor.name}`);
      log.debug(`Tool config type: ${config.type || "command"}`);
    }

    // Merge args with defaults.
    const mergedArgs: Args = {
      ...(config.default_args ?? {}),
      ...args,
    };

    try {
      executor.getValidator().validateToolExecution(mergedArgs);
      if (log.isVerbose()) {
        log.debug(`Tool arguments validated: ${JSON.stringify(mergedArgs)}`);
      }
    } catch (e) {
      const validationError = (e as Error).message;
      log.warn(`Tool validation failed: ${validationError}`);
      return { content: `Validation error: ${validationError}`, isError: true };
    }

    // Apply preprocessor (path normalization).
    const processedArgs = this.argPreprocessor(mergedArgs);
    // @FIXME make this actually check if path normalization was applied
    if (JSON.stringify(mergedArgs) !== JSON.stringify(processedArgs)) {
      if (log.isVerbose()) {
        log.debug(
          `Path normalization applied: ${JSON.stringify(processedArgs)}`,
        );
      }
    }

    const startTime = Date.now();
    try {
      const result = await executor.execute(processedArgs);
      const duration = Date.now() - startTime;
      if (log.isVerbose()) {
        log.debug(`Tool ${name} executed successfully in ${duration}ms`);
      }
      return result;
    } catch (e) {
      const duration = Date.now() - startTime;
      const message = e instanceof Error ? e.message : e;

      // If the executor has an isTimeout method, use it to determine if this
      // was a timeout error.
      if (executor.isTimeout?.(duration)) {
        log.error(`Tool ${name} execution timeout: ${duration}ms: ${message}`);
        if (log.isVerbose()) {
          log.debug(
            `Tool ${name} timed out with args: ${JSON.stringify(processedArgs)}`,
          );
        }
        return {
          content: `Tool ${name} timed out after ${duration}ms: ${message}`,
          isTimeout: true,
        };
      }

      // Handle as a regular execution error.
      const execError = (e as Error).message;
      log.error(`Tool execution error after ${duration}ms: ${execError}`);
      if (log.isVerbose()) {
        log.debug(
          `Tool that failed: ${name}, executor: ${executor.constructor.name}`,
        );
      }
      return {
        content: `Error after ${duration}ms: ${execError}`,
        isError: true,
      };
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
