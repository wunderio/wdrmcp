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
import { resolveEnvVars } from "./env-resolve.js";
import { SshExecutor } from "./executors/ssh.js";
import { CommandToolExecutor } from "./executors/command.js";
import { McpProxyExecutor, BoundRemoteToolExecutor } from "./executors/mcp-proxy.js";
import { McpStdioExecutor } from "./executors/mcp-stdio.js";
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
  McpStdioToolConfig,
  ContainerExecutor,
  RemoteToolProvider,
} from "./types.js";

const ValidationRuleSchema = z.object({
  pattern: z.string(),
  message: z.string().optional(),
  field: z.string().optional(),
}).strict();

const JsonSchemaPropertySchema: z.ZodType = z.lazy(() => z.object({
  type: z.string(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  items: z.lazy(() => JsonSchemaPropertySchema).optional(),
}).strict());

const JsonSchemaSchema: z.ZodType = z.lazy(() => z.object({
  type: z.string(),
  properties: z.record(JsonSchemaPropertySchema).optional(),
  required: z.array(z.string()).optional(),
}).strict());

const CommandToolConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  description: z.string(),
  type: z.literal("command"),
  input_schema: JsonSchemaSchema.optional(),
  command_template: z.string(),
  ssh_target: z.string(),
  ssh_user: z.string().optional(),
  working_dir: z.string().optional(),
  shell: z.string().optional(),
  default_args: z.record(z.union([z.string(), z.array(z.string())])).optional(),
  disallowed_commands: z.array(z.union([
    z.string(),
    z.object({ pattern: z.string(), suggested_tool: z.string().optional() }).strict(),
  ])).optional(),
  validation_rules: z.array(ValidationRuleSchema).optional(),
  max_arg_length: z.number().int().positive().optional(),
}).strict();

const McpServerToolConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  description: z.string(),
  type: z.literal("mcp_server"),
  input_schema: JsonSchemaSchema.optional(),
  server_url: z.string(),
  tool_prefix: z.string().optional(),
  forward_args: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
  auth_username: z.string().optional(),
  auth_password: z.string().optional(),
  auth_token: z.string().optional(),
  auth_token_basic: z.boolean().optional(),
  expose_remote_tools: z.boolean().optional(),
  init_timeout: z.number().int().positive().optional(),
}).strict();

const McpStdioToolConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  description: z.string(),
  type: z.literal("mcp_stdio"),
  input_schema: JsonSchemaSchema.optional(),
  command: z.string(),
  ssh_target: z.string().optional(),
  ssh_user: z.string().optional(),
  working_dir: z.string().optional(),
  expose_remote_tools: z.boolean().optional(),
  tool_prefix: z.string().optional(),
  init_timeout: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
}).strict();

const ToolConfigSchema = z.discriminatedUnion("type", [
  CommandToolConfigSchema,
  McpServerToolConfigSchema,
  McpStdioToolConfigSchema,
]);

const ToolsFileSchemaValidator = z.object({
  tools: z.array(ToolConfigSchema),
}).strict();

export class ToolRegistry {
  private readonly toolsConfigDir: string;
  private readonly config: BridgeConfig;
  private readonly tools: Map<string, RegisteredTool> = new Map();
  private readonly argPreprocessor: ArgPreprocessor;
  private readonly containerExecutor: ContainerExecutor;
  private readonly stdioExecutors: McpStdioExecutor[] = [];

  constructor(toolsConfigDir: string, config: BridgeConfig) {
    this.toolsConfigDir = resolve(toolsConfigDir);
    this.config = config;

    // Initialize standard container executor (now SSH based)
    // Pass the configured SSH user or fall back to environment
    this.containerExecutor = new SshExecutor({
      defaultUser: config.sshUser,
      strictHostKeyChecking: config.strictHostKeyChecking,
    });

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

        if (!parsed) { log.warn(`Empty config file: ${file}`); continue; }

        const validation = ToolsFileSchemaValidator.safeParse(parsed);
        if (!validation.success) {
          const details = validation.error.issues
            .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
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
        log.error(`Error loading ${file}: ${e instanceof yaml.YAMLException ? e.message : e}`);
      }
    }

    log.info(`Loaded ${loadedCount} tools total`);
    return loadedCount;
  }

  private async loadSingleTool(toolConfig: ToolConfig): Promise<number> {
    const log = getLogger();
    const name = toolConfig.name;

    if (!name) { log.warn("Tool config missing 'name'"); return 0; }
    if (toolConfig.enabled === false) { log.info(`Tool disabled: ${name}`); return 0; }

    const executor = this.createExecutor(toolConfig);
    if (!executor) { log.warn(`Failed to create executor: ${name}`); return 0; }

    // MCP server/stdio with expose_remote_tools: register each remote tool individually.
    if (toolConfig.type === "mcp_server" && (toolConfig as McpServerToolConfig).expose_remote_tools) {
      return this.loadRemoteMcpTools(toolConfig as McpServerToolConfig, executor as McpProxyExecutor);
    }
    if (toolConfig.type === "mcp_stdio" && (toolConfig as McpStdioToolConfig).expose_remote_tools) {
      return this.loadRemoteMcpTools(toolConfig as McpStdioToolConfig, executor as McpStdioExecutor);
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
    providerConfig: McpServerToolConfig | McpStdioToolConfig,
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
          setTimeout(() => reject(new Error(`Timeout after ${initTimeout}s`)), initTimeout * 1000),
        ),
      ]);

      if (!remoteTools?.length) { log.warn(`No tools from ${providerName}`); return 0; }

      const prefix = providerConfig.tool_prefix ?? `${providerName}_`;
      let count = 0;

      for (const remote of remoteTools) {
        if (!remote.name) continue;

        const localName = `${prefix}${remote.name}`;

        // Each remote tool gets its own bound executor — no special-casing in executeTool().
        const boundExecutor = new BoundRemoteToolExecutor(provider, remote.name);

        const wrappedConfig: ToolConfig = {
          ...providerConfig,
          name: localName,
          description: remote.description ?? "",
          input_schema: remote.inputSchema as ToolConfig["input_schema"],
        };

        this.tools.set(localName, { config: wrappedConfig, executor: boundExecutor });
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

  private createExecutor(toolConfig: ToolConfig): ToolExecutor | null {
    const log = getLogger();
    const type = toolConfig.type ?? "command";
    const name = toolConfig.name;

    try {
      if (type === "command") {
        const cfg = toolConfig as CommandToolConfig;
        if (!cfg.command_template) { log.error(`Tool ${name}: missing command_template`); return null; }
        if (!cfg.ssh_target) { log.error(`Tool ${name}: missing ssh_target`); return null; }

        // Resolve environment variables and bridge placeholders
        const envVars = {
          ...(process.env as Record<string, string | undefined>),
          DDEV_SSH_USER: process.env.DDEV_SSH_USER ?? this.config.sshUser,
        };
        const bridgeVars = { DDEV_PROJECT: this.config.ddevProject };

        const sshTarget = resolveEnvVars(cfg.ssh_target, envVars, bridgeVars);
        this.ensureNoUnresolvedEnvPlaceholders(sshTarget, name, "ssh_target");

        const sshUser = cfg.ssh_user ? resolveEnvVars(cfg.ssh_user, envVars, bridgeVars) : undefined;
        if (sshUser) {
          this.ensureNoUnresolvedEnvPlaceholders(sshUser, name, "ssh_user");
        }

        const workingDir = cfg.working_dir ? resolveEnvVars(cfg.working_dir, envVars, bridgeVars) : undefined;
        if (workingDir) {
          this.ensureNoUnresolvedEnvPlaceholders(workingDir, name, "working_dir");
        }

        return new CommandToolExecutor({
          commandTemplate: cfg.command_template,
          host: sshTarget,
          executor: this.containerExecutor, // Inject SSH executor
          sshUser,
          shell: cfg.shell,
          workingDir,
          defaultArgs: cfg.default_args,
          disallowedCommands: cfg.disallowed_commands,
          validationRules: cfg.validation_rules,
          maxArgLength: cfg.max_arg_length,
        });
      }

      if (type === "mcp_server") {
        const cfg = toolConfig as McpServerToolConfig;
        if (!cfg.server_url) { log.error(`Tool ${name}: missing server_url`); return null; }

        const envVars = {
          ...(process.env as Record<string, string | undefined>),
          DDEV_SSH_USER: process.env.DDEV_SSH_USER ?? this.config.sshUser,
        };
        const bridgeVars = { DDEV_PROJECT: this.config.ddevProject };

        const authUsername = cfg.auth_username
          ? resolveEnvVars(cfg.auth_username, envVars, bridgeVars)
          : undefined;
        if (authUsername) {
          this.ensureNoUnresolvedEnvPlaceholders(authUsername, name, "auth_username");
        }

        const authPassword = cfg.auth_password
          ? resolveEnvVars(cfg.auth_password, envVars, bridgeVars)
          : undefined;
        if (authPassword) {
          this.ensureNoUnresolvedEnvPlaceholders(authPassword, name, "auth_password");
        }

        const authToken = cfg.auth_token
          ? resolveEnvVars(cfg.auth_token, envVars, bridgeVars)
          : undefined;
        if (authToken) {
          this.ensureNoUnresolvedEnvPlaceholders(authToken, name, "auth_token");
        }

        if ((cfg.auth_token && !cfg.auth_token.includes("${")) ||
            (cfg.auth_password && !cfg.auth_password.includes("${"))) {
          log.warn(`Tool ${name}: auth credentials appear to be literal values; prefer environment variable placeholders`);
        }

        return new McpProxyExecutor({
          serverUrl: cfg.server_url,
          forwardArgs: cfg.forward_args,
          timeout: cfg.timeout,
          authUsername,
          authPassword,
          authToken,
          authTokenBasic: cfg.auth_token_basic,
        });
      }

      if (type === "mcp_stdio") {
        const cfg = toolConfig as McpStdioToolConfig;
        if (!cfg.command) { log.error(`Tool ${name}: missing command`); return null; }

        const envVars = {
          ...(process.env as Record<string, string | undefined>),
          DDEV_SSH_USER: process.env.DDEV_SSH_USER ?? this.config.sshUser,
        };
        const bridgeVars = { DDEV_PROJECT: this.config.ddevProject };

        const sshTarget = cfg.ssh_target
          ? resolveEnvVars(cfg.ssh_target, envVars, bridgeVars)
          : undefined;
        if (sshTarget) {
          this.ensureNoUnresolvedEnvPlaceholders(sshTarget, name, "ssh_target");
        }

        const sshUser = cfg.ssh_user
          ? resolveEnvVars(cfg.ssh_user, envVars, bridgeVars)
          : undefined;
        if (sshUser) {
          this.ensureNoUnresolvedEnvPlaceholders(sshUser, name, "ssh_user");
        }

        const workingDir = cfg.working_dir
          ? resolveEnvVars(cfg.working_dir, envVars, bridgeVars)
          : undefined;
        if (workingDir) {
          this.ensureNoUnresolvedEnvPlaceholders(workingDir, name, "working_dir");
        }

        const executor = new McpStdioExecutor({
          command: cfg.command,
          sshTarget,
          sshUser,
          workingDir,
          initTimeout: cfg.init_timeout,
          timeout: cfg.timeout,
          strictHostKeyChecking: this.config.strictHostKeyChecking,
        });

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

  getToolNames(): string[] { return [...this.tools.keys()]; }
  getTool(name: string): RegisteredTool | undefined { return this.tools.get(name); }
  getAllTools(): Map<string, RegisteredTool> { return this.tools; }

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
  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
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

    try {
      executor.validateArguments(args);
      if (log.isVerbose()) {
        log.debug(`Tool arguments validated: ${JSON.stringify(args)}`);
      }
    } catch (e) {
      const validationError = (e as Error).message;
      log.warn(`Tool validation failed: ${validationError}`);
      return { content: `Validation error: ${validationError}`, isError: true };
    }

    // Apply preprocessor (path normalization).
    const processedArgs = this.argPreprocessor(args);
    if (JSON.stringify(args) !== JSON.stringify(processedArgs)) {
      if (log.isVerbose()) {
        log.debug(`Path normalization applied: ${JSON.stringify(processedArgs)}`);
      }
    }

    try {
      return await executor.execute(processedArgs);
    } catch (e) {
      const execError = (e as Error).message;
      log.error(`Tool execution error: ${execError}`);
      if (log.isVerbose()) {
        log.debug(`Tool that failed: ${name}, executor: ${executor.constructor.name}`);
      }
      return { content: `Error: ${execError}`, isError: true };
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

  private ensureNoUnresolvedEnvPlaceholders(value: string, toolName: string, fieldName: string): void {
    const unresolved = [...value.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]);
    if (unresolved.length === 0) {
      return;
    }

    throw new Error(
      `Tool ${toolName}: missing required environment variable(s) for ${fieldName}: ${unresolved.join(", ")}`,
    );
  }
}
