/**
 * Core type definitions for WDRMCP.
 */

import type { Args } from "./args.js";
import type { BaseToolConfig } from "./base.js";
import type { ValidatorInterface } from "./validation.js";

import type { CommandToolConfig } from "../executors/command.js";
import type { CheckToolConfig } from "../executors/check.js";
import type { McpProxyToolConfig } from "../executors/mcp-proxy.js";
import type { McpStdioToolConfig } from "../executors/mcp-stdio.js";

/** Union type for all tool configurations. */
export type ToolConfig =
  | CommandToolConfig
  | CheckToolConfig
  | McpProxyToolConfig
  | McpStdioToolConfig;

export type ExecutorConfig<T> = {
  toolConfig: T;
  bridgeConfig: BridgeConfig;
  baseConfig: BaseToolConfig;
  executor?: ToolExecutor;
  /**
   * Resolves env and bridge vars in the value of the given property.
   * Ensures that no placeholders are left in the value.
   */
  resolvePlaceholders(propertyName: string): string | undefined;
};

/** Remote tool definition as returned by tools/list. */
export interface RemoteToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Interface for executors that can discover and call remote MCP tools. */
export interface RemoteToolProvider extends ToolExecutor {
  fetchRemoteTools(): Promise<RemoteToolDefinition[]>;
  callTool(args: Args, toolName?: string): Promise<ToolExecutionResult>;
}

/** Top-level structure of a tools YAML file. */
export interface ToolsFileSchema {
  tools: ToolConfig[];
}

/** Result of a tool execution. */
export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  isTimeout?: boolean;
}

/** A registered tool with its executor. */
export interface RegisteredTool {
  config: ToolConfig;
  executor: ToolExecutor;
}

/** Interface for static methods of tool executors. */
export interface ToolExecutorStatic {
  create(executorConfig: ExecutorConfig<ToolConfig>): ToolExecutor;
}

/** Interface that all executors must implement. */
export interface ToolExecutor {
  execute(args: Args): Promise<ToolExecutionResult>;
  getValidator(): ValidatorInterface;
  isTimeout?(durationMs: number): boolean;
}

/**
 * Argument preprocessor — transforms args before they reach the executor.
 * Used for path normalization, default merging, etc.
 */
export type ArgPreprocessor = (args: Args) => Args;

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
  /** Enforce SSH host key validation. */
  strictHostKeyChecking: boolean;
  /** Enable verbose logging (full outputs, extensive debugging). */
  verboseLogging: boolean;
}
