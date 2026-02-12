/**
 * Core type definitions for WDRMCP.
 */

/** Supported tool types in YAML configuration. */
export type ToolType = "command" | "mcp_server";

/** A single validation rule for tool arguments. */
export interface ValidationRule {
  pattern: string;
  message: string;
}

/** Base tool configuration shared by all tool types. */
export interface BaseToolConfig {
  name: string;
  enabled?: boolean;
  description: string;
  type: ToolType;
  input_schema?: JsonSchema;
}

/** JSON Schema definition used in YAML tool configs. */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

/** Configuration for a command-type tool (SSH execution). */
export interface CommandToolConfig extends BaseToolConfig {
  type: "command";
  command_template: string;
  ssh_target: string;  // e.g. "web" or "{DDEV_PROJECT}.ddev.site"
  ssh_user?: string;   // e.g. "${DDEV_SSH_USER}", defaults to current user
  working_dir?: string; // Optional working directory for execution
  shell?: string;
  default_args?: Record<string, string>;
  disallowed_commands?: string[];
  validation_rules?: ValidationRule[];
}

/** Configuration for an MCP server proxy tool. */
export interface McpServerToolConfig extends BaseToolConfig {
  type: "mcp_server";
  server_url: string;
  forward_args?: boolean;
  timeout?: number;
  auth_username?: string;
  auth_password?: string;
  auth_token?: string;
  auth_token_basic?: boolean;
  verify_ssl?: boolean;
  expose_remote_tools?: boolean;
  tool_prefix?: string;
  init_timeout?: number;
}

/** Union type for all tool configurations. */
export type ToolConfig = CommandToolConfig | McpServerToolConfig;

/** Top-level structure of a tools YAML file. */
export interface ToolsFileSchema {
  tools: ToolConfig[];
}

/** Result of a tool execution. */
export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
}

/** A registered tool with its executor. */
export interface RegisteredTool {
  config: ToolConfig;
  executor: ToolExecutor;
}

/** Interface that all executors must implement. */
export interface ToolExecutor {
  execute(args: Record<string, unknown>): Promise<ToolExecutionResult>;
  validateArguments(args: Record<string, unknown>): void;
}

/**
 * Argument preprocessor — transforms args before they reach the executor.
 * Used for path normalization, default merging, etc.
 */
export type ArgPreprocessor = (
  args: Record<string, unknown>,
) => Record<string, unknown>;

/** Bridge-level configuration. */
export interface BridgeConfig {
  /** Path to the directory containing tools-config YAML files. */
  toolsConfigPath: string;
  /** DDEV project name (from DDEV_PROJECT env var). */
  ddevProject: string;
  /** Log level. */
  logLevel: "debug" | "info" | "warn" | "error";
  /** Optional log file path. */
  logFile?: string;
  /** Host project root for path normalization. */
  hostProjectRoot: string;
  /** Container project root for path normalization. */
  containerProjectRoot: string;
  /** SSH user for container connections (defaults to current user). */
  sshUser?: string;
}

/** Interface for executing commands via SSH. */
export interface ContainerExecutor {
  execute(options: {
    host: string;        // SSH hostname/target
    command: string[];
    user?: string;
    shell?: string;
    workingDir?: string;
  }): Promise<string>;
}
