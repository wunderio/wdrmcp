/**
 * CommandToolExecutor — executes shell commands in Docker containers
 * with argument substitution ({placeholder} syntax).
 *
 * Refactored from the Python version with these improvements:
 *  - Static safety checks happen at construction time (not per-call)
 *  - Container validation and UID resolution are cached in docker.ts
 *  - Path normalization is an external preprocessor (not baked in)
 *  - No abstract base class; implements ToolExecutor interface directly
 */

import {
  dockerExec,
  validateContainer,
  validateStaticSafety,
  resolveContainerUser,
} from "../docker.js";
import { getLogger } from "../logger.js";
import type { ToolExecutionResult, ToolExecutor, ValidationRule } from "../types.js";

export interface CommandExecutorOptions {
  commandTemplate: string;
  container: string;
  ddevProject: string;
  user?: string;
  shell?: string;
  defaultArgs?: Record<string, string>;
  disallowedCommands?: string[];
  validationRules?: ValidationRule[];
}

export class CommandToolExecutor implements ToolExecutor {
  private readonly commandTemplate: string;
  private readonly container: string;
  private readonly ddevProject: string;
  private readonly user: string;
  private readonly shell: string;
  private readonly defaultArgs: Record<string, string>;
  private readonly disallowedCommands: Set<string>;
  private readonly validationRules: ValidationRule[];

  constructor(options: CommandExecutorOptions) {
    this.commandTemplate = options.commandTemplate;
    this.container = options.container;
    this.ddevProject = options.ddevProject;
    this.user = options.user ?? "www-data";
    this.shell = options.shell ?? "/bin/bash";
    this.defaultArgs = options.defaultArgs ?? {};
    this.disallowedCommands = new Set(options.disallowedCommands ?? []);
    this.validationRules = options.validationRules ?? [];

    // Static safety: validate shell and flag at construction, not per-call.
    validateStaticSafety([this.shell, "-c"]);
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const log = getLogger();

    // Resolve user (cached after first call).
    const user = await resolveContainerUser(this.user, this.container);

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

    // Validate container ownership (cached after first call).
    try {
      await validateContainer(this.container, this.ddevProject);
    } catch (e) {
      log.warn(`Container validation: ${(e as Error).message}`);
    }

    // Execute in Docker container.
    try {
      log.info(`EXEC: ${this.container} as ${user}: ${this.shell} -c ...`);
      const output = await dockerExec({
        container: this.container,
        command: [cmdStr],
        user,
        shell: this.shell,
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
