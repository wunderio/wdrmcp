/**
 * CommandToolExecutor — executes shell commands via SSH
 * with argument substitution ({placeholder} syntax).
 */

import { getLogger } from "../logger.js";
import type { ToolExecutionResult, ToolExecutor, ValidationRule, DisallowedCommand, ContainerExecutor } from "../types.js";

export interface CommandExecutorOptions {
  commandTemplate: string;
  host: string;  // SSH target hostname
  executor: ContainerExecutor; // Dependency injection
  sshUser?: string;
  shell?: string;
  workingDir?: string;
  defaultArgs?: Record<string, string | string[]>;
  disallowedCommands?: (string | DisallowedCommand)[];
  validationRules?: ValidationRule[];
  maxArgLength?: number;
}

export class CommandToolExecutor implements ToolExecutor {
  private readonly commandTemplate: string;
  private readonly host: string;
  private readonly executor: ContainerExecutor;
  private readonly sshUser?: string;
  private readonly shell: string;
  private readonly workingDir?: string;
  private readonly defaultArgs: Record<string, string | string[]>;
  private readonly disallowedCommands: DisallowedCommand[];
  private readonly validationRules: ValidationRule[];
  private readonly maxArgLength: number;

  constructor(options: CommandExecutorOptions) {
    this.commandTemplate = options.commandTemplate;
    this.host = options.host;
    this.executor = options.executor;
    this.sshUser = options.sshUser;
    this.shell = options.shell ?? "/bin/bash";
    this.workingDir = options.workingDir;
    this.defaultArgs = options.defaultArgs ?? {};
    this.disallowedCommands = (options.disallowedCommands ?? []).map((d) =>
      typeof d === "string" ? { pattern: d } : d,
    );
    this.validationRules = options.validationRules ?? [];
    this.maxArgLength = options.maxArgLength ?? 4096;
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const log = getLogger();
    const startTime = Date.now();

    // Merge with defaults.
    const mergedArgs: Record<string, unknown> = { ...this.defaultArgs, ...args };
    if (log.isVerbose()) {
      log.debug(`Executing with args:`, mergedArgs);
    }

    // Check disallowed patterns against all provided string arguments.
    for (const value of Object.values(mergedArgs)) {
      const strings: string[] = Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === "string")
        : typeof value === "string" ? [value] : [];
      for (const str of strings) {
        const blocked = this.matchesDisallowed(str);
        if (blocked) {
          log.warn(`Blocked disallowed command in arguments`);
          return { content: this.formatBlockedMessage(blocked), isError: true };
        }
      }
    }

    // Substitute arguments into template.
    let cmdStr: string;
    try {
      if (log.isVerbose()) {
        log.debug(`Command template: ${this.commandTemplate}`);
      }
      cmdStr = this.commandTemplate.replace(/\{(\w+)\}/g, (_match, key) => {
        if (key in mergedArgs) {
          const raw = mergedArgs[key];
          // Array values: escape each element individually, join with spaces.
          if (Array.isArray(raw)) {
            const parts = (raw as unknown[]).map(String).filter(Boolean);
            return parts.map((p) => this.escapeShellArg(p)).join(" ");
          }
          const val = String(raw);
          return val === "" ? "" : this.escapeShellArg(val);
        }
        throw new Error(`Missing required argument: ${key}`);
      });
      // Collapse extra whitespace left by empty placeholders.
      cmdStr = cmdStr.replace(/  +/g, " ").trim();
      if (log.isVerbose()) {
        log.debug(`Rendered command: ${cmdStr}`);
      }
    } catch (e) {
      log.warn(`Argument substitution failed: ${(e as Error).message}`);
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }

    // Validate rendered command against rules.
    const ruleError = this.checkRules(cmdStr);
    if (ruleError) {
      log.warn(`Validation failed: ${ruleError}`);
      return { content: `Validation error: ${ruleError}`, isError: true };
    }

    const blocked = this.matchesDisallowed(cmdStr);
    if (blocked) {
      log.warn(`Blocked disallowed command in rendered template`);
      return { content: this.formatBlockedMessage(blocked), isError: true };
    }

    // Execute via injected executor (SSH or other).
    try {
      log.info(`EXEC: ${this.host} via ${this.executor.constructor.name}, shell: ${this.shell}, workdir: ${this.workingDir || "default"}`);
      const output = await this.executor.execute({
        host: this.host,
        command: [cmdStr],
        user: this.sshUser,
        shell: this.shell,
        workingDir: this.workingDir,
      });
      const trimmedOutput = output.trim();
      const duration = Date.now() - startTime;
      log.info(`EXEC SUCCESS: ${this.host} (${duration}ms)`);
      
      // Add success message for empty outputs
      if (trimmedOutput.length === 0) {
        return { content: "Command completed successfully (no output)" };
      }
      
      return { content: trimmedOutput };
    } catch (e) {
      const duration = Date.now() - startTime;
      const errorMsg = (e as Error).message;
      log.error(`EXEC FAILED: ${this.host} (${duration}ms), error: ${errorMsg}`);
      if (log.isVerbose()) {
        log.debug(`Failed command: ${cmdStr}`);
      }
      return { 
        content: `Command failed: ${errorMsg}`,
        isError: true 
      };
    }
  }

  validateArguments(args: Record<string, unknown>): void {
    // Check validation rules and max-length against each string argument value.
    for (const [key, value] of Object.entries(args)) {
      const strings: string[] = Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === "string")
        : typeof value === "string" ? [value] : [];

      for (const str of strings) {
        if (str.length > this.maxArgLength) {
          throw new Error(`Argument '${key}' exceeds max length of ${this.maxArgLength}`);
        }

        const ruleError = this.checkRules(str, key);
        if (ruleError) {
          throw new Error(ruleError);
        }
      }
    }

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

  /**
   * Check validation rules against a value. Returns error message or null.
   * When fieldName is provided, only rules targeting that field (or all fields) apply.
   * When fieldName is omitted (rendered command check), only non-field-specific rules apply.
   */
  private checkRules(value: string, fieldName?: string): string | null {
    for (const rule of this.validationRules) {
      // Field-specific rules only match the named field.
      // Non-field rules match everything (individual args + rendered command).
      if (rule.field) {
        if (fieldName !== rule.field) continue;
      }
      if (rule.pattern && new RegExp(rule.pattern).test(value)) {
        return rule.message ?? `Validation failed for pattern: ${rule.pattern}`;
      }
    }
    return null;
  }

  private escapeShellArg(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }

  private matchesDisallowed(value: string): DisallowedCommand | null {
    for (const entry of this.disallowedCommands) {
      const pat = entry.pattern?.trim();
      if (!pat) continue;

      const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(?:^|[\\s;&|()])${escaped}(?:$|[\\s;&|()])`, "i");
      if (regex.test(value)) {
        return entry;
      }
    }
    return null;
  }

  private formatBlockedMessage(match: DisallowedCommand): string {
    const base = `Error: Command contains blocked pattern '${match.pattern}'`;
    return match.suggested_tool
      ? `${base}. Use the '${match.suggested_tool}' tool instead.`
      : base;
  }
}
