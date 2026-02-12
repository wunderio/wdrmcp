/**
 * CommandToolExecutor — executes shell commands via SSH
 * with argument substitution ({placeholder} syntax).
 */

import { getLogger } from "../logger.js";
import type { ToolExecutionResult, ToolExecutor, ValidationRule, ContainerExecutor } from "../types.js";

export interface CommandExecutorOptions {
  commandTemplate: string;
  host: string;  // SSH target hostname
  executor: ContainerExecutor; // Dependency injection
  sshUser?: string;
  shell?: string;
  workingDir?: string;
  defaultArgs?: Record<string, string>;
  disallowedCommands?: string[];
  validationRules?: ValidationRule[];
}

export class CommandToolExecutor implements ToolExecutor {
  private readonly commandTemplate: string;
  private readonly host: string;
  private readonly executor: ContainerExecutor;
  private readonly sshUser?: string;
  private readonly shell: string;
  private readonly workingDir?: string;
  private readonly defaultArgs: Record<string, string>;
  private readonly disallowedCommands: Set<string>;
  private readonly validationRules: ValidationRule[];

  constructor(options: CommandExecutorOptions) {
    this.commandTemplate = options.commandTemplate;
    this.host = options.host;
    this.executor = options.executor;
    this.sshUser = options.sshUser;
    this.shell = options.shell ?? "/bin/bash";
    this.workingDir = options.workingDir;
    this.defaultArgs = options.defaultArgs ?? {};
    this.disallowedCommands = new Set(options.disallowedCommands ?? []);
    this.validationRules = options.validationRules ?? [];
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const log = getLogger();

    // Merge with defaults.
    const mergedArgs: Record<string, unknown> = { ...this.defaultArgs, ...args };

    // Check disallowed commands.
    if (typeof mergedArgs.command === "string" && this.disallowedCommands.has(mergedArgs.command)) {
      log.warn(`Blocked disallowed command: ${mergedArgs.command}`);
      return { content: `Error: Command '${mergedArgs.command}' is not allowed`, isError: true };
    }

    // Substitute arguments into template.
    let cmdStr: string;
    try {
      cmdStr = this.commandTemplate.replace(/\{(\w+)\}/g, (_match, key) => {
        if (key in mergedArgs) return String(mergedArgs[key]);
        throw new Error(`Missing required argument: ${key}`);
      });
    } catch (e) {
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }

    // Validate rendered command against rules.
    const ruleError = this.checkRules(cmdStr);
    if (ruleError) {
      return { content: `Validation error: ${ruleError}`, isError: true };
    }

    // Execute via injected executor (SSH or other).
    try {
      log.info(`EXEC: ${this.host} via ${this.executor.constructor.name}`);
      const output = await this.executor.execute({
        host: this.host,
        command: [cmdStr],
        user: this.sshUser,
        shell: this.shell,
        workingDir: this.workingDir,
      });
      return { content: output.trim() };
    } catch (e) {
      return { content: `Execution failed: ${(e as Error).message}`, isError: true };
    }
  }

  validateArguments(args: Record<string, unknown>): void {
    // Check validation rules against stringified arguments.
    const ruleError = this.checkRules(JSON.stringify(args));
    if (ruleError) throw new Error(ruleError);

    // Verify required placeholders are provided.
    const placeholders = new Set(
      [...this.commandTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
    );
    const provided = new Set([...Object.keys(this.defaultArgs), ...Object.keys(args)]);
    const missing = [...placeholders].filter((p) => !provided.has(p));

    if (missing.length > 0) {
      throw new Error(`Missing required arguments: ${missing.join(", ")}`);
    }
  }

  /** Check validation rules against a value. Returns error message or null. */
  private checkRules(value: string): string | null {
    for (const rule of this.validationRules) {
      if (rule.pattern && new RegExp(rule.pattern).test(value)) {
        return rule.message ?? `Validation failed for pattern: ${rule.pattern}`;
      }
    }
    return null;
  }
}
