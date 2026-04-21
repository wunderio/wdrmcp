import { getLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import type {
  DisallowedCommand,
  ValidationRule,
  ValidatorInterface,
} from "../types/validation.js";

type Args = Record<string, unknown>;

type ValidatorOptions = {
  commandTemplate?: string;
  disallowedCommands?: (string | DisallowedCommand)[];
  validationRules?: ValidationRule[];
  maxArgLength?: number;
};

export default class Validator implements ValidatorInterface {
  private readonly log: Logger;

  private readonly commandTemplate?: string;
  private readonly disallowedCommands: DisallowedCommand[];
  private readonly validationRules: ValidationRule[];
  private readonly maxArgLength: number;

  constructor(options: ValidatorOptions) {
    this.log = getLogger();

    this.commandTemplate = options.commandTemplate;
    this.disallowedCommands = (options?.disallowedCommands ?? []).map((d) =>
      typeof d === "string" ? { pattern: d } : d,
    );
    this.validationRules = options?.validationRules ?? [];
    this.maxArgLength = options?.maxArgLength ?? 4096;
  }

  /**
   * Assembles a command string from a template and arguments.
   * Validates the command and args against rules and disallowed patterns.
   *
   * @throws Error if any validation fails.
   */
  assembleCommand(commandTemplate: string, args: Args): string {
    // Check disallowed patterns against all provided string arguments.
    this.validateCommandArgs(args);

    // Substitute arguments into template.
    const cmdStr = this.renderCommand(commandTemplate, args);

    // Validate rendered command against rules.
    this.validateRules(cmdStr);
    this.validateDisallowedPatterns(cmdStr, "rendered template");

    return cmdStr;
  }

  /**
   * Check args during a tool call execution.
   *
   * @throws Error if any argument fails validation.
   */
  validateToolExecution(args: Args): void {
    // Check validation rules and max-length against each string argument value.
    for (const [key, value] of Object.entries(args)) {
      const strings: string[] = Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === "string")
        : typeof value === "string"
          ? [value]
          : [];

      for (const str of strings) {
        if (str.length > this.maxArgLength) {
          throw new Error(
            `Validator: Argument '${key}' exceeds max length of ${this.maxArgLength}`,
          );
        }
        this.validateRules(str, key);
      }
    }

    if (this.commandTemplate) {
      // Verify required placeholders are provided.
      const placeholders = new Set(
        [...this.commandTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
      );
      const provided = new Set(Object.keys(args));
      const missing = [...placeholders].filter((p) => !provided.has(p));

      if (missing.length > 0) {
        throw new Error(
          `Validator: Command template is missing required arguments: ${missing.join(", ")}`,
        );
      }
    }
  }

  /**
   * Render a command template into a string, substituting placeholders.
   * NOTE: This does not validate anything.
   *
   * @throws Error if a required placeholder is missing, or if an argument value
   *   cannot be rendered.
   */
  private renderCommand(commandTemplate: string, args: Args): string {
    let cmdStr: string;
    try {
      if (this.log.isVerbose()) {
        this.log.debug(`Validator: Command template: ${commandTemplate}`);
      }
      cmdStr = commandTemplate.replace(/\{(\w+)\}/g, (_match, key) => {
        if (key in args) {
          const raw = args[key];
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
      if (this.log.isVerbose()) {
        this.log.debug(`Rendered command: ${cmdStr}`);
      }
    } catch (e) {
      this.log.warn(`Argument substitution failed: ${(e as Error).message}`);
      // Just re-throw the error, it should be caught by the executor.
      throw e;
    }
    return cmdStr;
  }

  /**
   * Check validation rules against a value. Returns error message or null.
   * When fieldName is provided, only rules targeting that field (or all fields) apply.
   * When fieldName is omitted (rendered command check), only non-field-specific rules apply.
   *
   * @throws Error if any validation rule is violated.
   */
  private validateRules(value: string, fieldName?: string): void {
    for (const rule of this.validationRules) {
      // Field-specific rules only match the named field.
      // Non-field rules match everything (individual args + rendered command).
      if (rule.field) {
        if (fieldName !== rule.field) continue;
      }
      if (!rule.pattern) continue;

      let regex: RegExp;
      try {
        regex = new RegExp(rule.pattern);
      } catch (error) {
        const fieldContext = rule.field ? ` for field '${rule.field}'` : "";
        const reason =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Invalid validation rule pattern${fieldContext}: '${rule.pattern}'. ${reason}`,
        );
      }

      if (regex.test(value)) {
        throw new Error(
          rule.message ?? `Validation failed for pattern: ${rule.pattern}`,
        );
      }
    }
  }

  /**
   * Validates that no disallowed patterns are present in the arguments.
   *
   * @throws Error if a disallowed pattern is found.
   */
  private validateCommandArgs(args: Args): void {
    for (const value of Object.values(args)) {
      const strings: string[] = Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === "string")
        : typeof value === "string"
          ? [value]
          : [];
      for (const str of strings) {
        this.validateDisallowedPatterns(str, "args");
      }
    }
  }

  /**
   * Validate that the given string does not contain any disallowed commands.
   *
   * @throws Error if a disallowed pattern is found.
   */
  private validateDisallowedPatterns(value: string, source?: string): void {
    for (const entry of this.disallowedCommands) {
      const pat = entry.pattern?.trim();
      if (!pat) continue;

      const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(
        `(?:^|[\\s;&|()])${escaped}(?:$|[\\s;&|()])`,
        "i",
      );
      if (regex.test(value)) {
        this.log.warn(
          `Validator: Blocked disallowed command${source ? ` in ${source}` : ""}`,
        );
        throw new Error(this.formatBlockedMessage(entry));
      }
    }
  }

  /**
   * Format a blocked command message, including suggested tool if provided.
   */
  private formatBlockedMessage(match: DisallowedCommand): string {
    const base = `Command contains blocked pattern '${match.pattern}'`;
    return match.suggested_tool
      ? `${base}. Use the '${match.suggested_tool}' tool instead.`
      : base;
  }

  /**
   * Escape a string argument for safe inclusion in a shell command.
   */
  private escapeShellArg(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }
}
