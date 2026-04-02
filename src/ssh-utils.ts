/**
 * @file Utility functions for SSH connections and remote command execution.
 */

import { ALLOWED_ENVVARS } from "./constants.js";

interface SshArgOptions {
  host: string;
  user?: string;
  strictHostKeyChecking?: boolean;
}

/**
 * Adds single quotes around the given value; escapes any single quotes within.
 *
 * @param {string} value
 *   Value to add single quotes around.
 * @returns {string}
 *   Value wrapped in single quotes, and any single quotes within escaped.
 */
export function addSingleQuotes(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build a shell prelude that exports DDEV environment variables (DB_HOST, etc.)
 * from .ddev/config.yaml. SSH sessions don't inherit container env vars, so
 * commands that need a Drupal bootstrap (like drush) require this.
 */
export function buildDdevEnvPrelude(projectRootDir: string): string {
  const baseDir = projectRootDir.replace(/\/$/, "");
  const configPath = addSingleQuotes(`${baseDir}/.ddev/config.yaml`);

  return `if [ -f ${configPath} ]; then while IFS= read -r kv; do [ -n "$kv" ] && export "$kv"; done < <(awk -F'- ' '/- (${ALLOWED_ENVVARS.join("|")})=/ {print $2}' ${configPath}); fi; `;
}

/**
 * Build base SSH arguments (host key checking options + destination).
 * Shared by SshExecutor (command execution) and McpStdioExecutor (stdio transport).
 */
export function buildSshArgs(options: SshArgOptions): string[] {
  const args = ["-t", "-o", "LogLevel=ERROR"];
  if (options.strictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=yes");
  } else {
    args.push(
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
    );
  }
  const destination = options.user
    ? `${options.user}@${options.host}`
    : options.host;
  args.push(destination);
  return args;
}
