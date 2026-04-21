/**
 * @file Base types and schemas shared across multiple tool and executor types.
 *
 * These are used to ensure consistency and reduce duplication in defining tool
 * configs and executor options.
 */

import { z } from "zod";
import { ValidationRuleSchema, JsonSchemaSchema } from "../schema.js";

import type { JsonSchema } from "./json-schema.js";
import type { DisallowedCommand, ValidationRule } from "./validation.js";

/**
 * Base tool configuration schema for validating YAML config files.
 * Options common to all tool types are defined here.
 */
export const BaseToolConfigSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean().optional(),
    default_args: z
      .record(z.union([z.string(), z.array(z.string())]))
      .optional(),
    description: z.string(),
    input_schema: JsonSchemaSchema.optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Options common to executors which do validation of commands and arguments.
 * These are generally derived from the tool config.
 */
export const BaseToolValidationConfigSchema = z
  .object({
    disallowed_commands: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              pattern: z.string(),
              suggested_tool: z.string().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    max_arg_length: z.number().int().positive().optional(),
    validation_rules: z.array(ValidationRuleSchema).optional(),
  })
  .strict();

/**
 * Base tool configuration shared by all tool types.
 */
export interface BaseToolConfig {
  name: string;
  enabled?: boolean;
  description: string;
  default_args?: Record<string, string | string[]>;
  type: string; // Specific tool types will have more specific string literals here
  input_schema?: JsonSchema;
  disallowed_commands?: (string | DisallowedCommand)[];
  max_arg_length?: number;
  timeout?: number;
  validation_rules?: ValidationRule[];
}

/**
 * Base executor options shared by all executor types.
 * Generally, these are derived from the base tool config (above),
 * but extending types may include additional fields needed for execution.
 */
export interface BaseExecutorOptions {
  name: string;
  enabled?: boolean;
  description: string;
  defaultArgs?: Record<string, string | string[]>;
  type: string; // Specific tool types will have more specific string literals here
  inputSchema?: JsonSchema;
  disallowedCommands?: (string | DisallowedCommand)[];
  maxArgLength?: number;
  timeoutMs?: number;
  validationRules?: ValidationRule[];
}
