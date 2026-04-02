/**
 * List of envvars which are allowed to be passed to a remote host via SSH.
 */
export const ALLOWED_ENVVARS = [
  "DB_HOST",
  "DB_NAME",
  "DB_USER",
  "DB_PASS",
  "HASH_SALT",
  "ENVIRONMENT_NAME",
];

/**
 * Sentinel value for tool error reporting.
 */
export const TOOL_ERROR_SENTINEL = "__WDRMCP_TOOL_ERROR__";
