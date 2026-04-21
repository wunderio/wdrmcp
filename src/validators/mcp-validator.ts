import Validator from "./validator.js";
import type { Args } from "../types/args.js";

export default class McpValidator extends Validator {
  /**
   * Override validateToolExecution to skip argument validation for MCP tools.
   */
  validateToolExecution(args: Args): void {
    // This function intentionally left blank.
    // Remote servers handle their own validation.
  }
}
