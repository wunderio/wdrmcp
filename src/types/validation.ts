import type { Args } from "./args.js";

/** A single validation rule for tool arguments. */
export interface ValidationRule {
  pattern: string;
  message?: string;
  field?: string;
}

/** A disallowed command pattern with optional suggested alternative. */
export interface DisallowedCommand {
  pattern: string;
  suggested_tool?: string;
}

export interface ValidatorInterface {
  assembleCommand(commandTemplate: string, args: Args): string;
  validateToolExecution(args: Args): void;
}
