/**
 * Environment variable resolution utilities.
 *
 * Supports two placeholder syntaxes:
 * - {VAR} - simple placeholder (legacy)
 * - ${VAR} - environment variable (new)
 */

import { getLogger } from "./logger.js";

/**
 * Resolve environment variables and placeholders in a template string.
 *
 * Supports:
 * - {DDEV_PROJECT} → from BridgeConfig or env
 * - ${DDEV_SSH_USER} → from process.env
 * - ${HOME} → from process.env
 *
 * @param template The template string to resolve
 * @param envVars Optional custom environment variables (defaults to process.env)
 * @param bridgeVars Optional bridge-specific variables like ddevProject
 * @returns Resolved string
 */
export function resolveEnvVars(
  template: string,
  envVars: Record<string, string | undefined> = process.env as Record<string, string>,
  bridgeVars: Record<string, string> = {},
): string {
  const log = getLogger();
  let result = template;

  // Resolve ${VAR} syntax first (environment variables)
  result = result.replace(/\$\{(\w+)\}/g, (match, varName) => {
    const value = envVars[varName];
    if (!value) {
      log.warn(`Environment variable not found: ${varName}, keeping placeholder`);
      return match;
    }
    return value;
  });

  // Resolve {VAR} syntax (bridge-specific variables)
  result = result.replace(/\{(\w+)\}/g, (match, varName) => {
    const value = bridgeVars[varName];
    if (!value) {
      log.warn(`Bridge variable not found: ${varName}, keeping placeholder`);
      return match;
    }
    return value;
  });

  return result;
}

/**
 * Resolve environment variables in an object recursively.
 * Strings are resolved for placeholders, other types are returned as-is.
 */
export function resolveEnvVarsInObject(
  obj: Record<string, unknown>,
  envVars?: Record<string, string | undefined>,
  bridgeVars?: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = resolveEnvVars(value, envVars, bridgeVars);
    } else {
      result[key] = value;
    }
  }

  return result;
}
