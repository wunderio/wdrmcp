/**
 * CLI argument parsing and configuration loading.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import type { BridgeConfig } from "./types.js";

const DEFAULT_SSH_USER_FILE = "/workspace/.ddev/.agents/.runtime.env";

function readSshUserFromFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("DDEV_SSH_USER=")) {
      const value = trimmed.slice("DDEV_SSH_USER=".length).trim();
      return value || undefined;
    }
  }

  return undefined;
}

function loadEnvFileIfExists(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  dotenv.config({ path: filePath, override: false });
}

function loadProjectEnvFromToolsConfigPath(toolsConfigPath: string): void {
  const toolsConfigEnv = resolve(toolsConfigPath, ".env");
  loadEnvFileIfExists(toolsConfigEnv);
}

function printUsage(): void {
  console.error(`
Usage: wdrmcp --tools-config <path> [options]

Options:
  --tools-config <path>   Path to directory containing YAML tool configuration files (required)
  --log-level <level>     Log level: debug, info, warn, error (default: info)
  --log-file <path>       Path to log file (default: /tmp/wdrmcp.log)
  --strict-host-key-checking  Enforce SSH host key verification (default: false)
  --verbose               Enable extensive logging (full outputs, command details, debug info)
  --help                  Show this help message

Environment variables:
  DDEV_PROJECT            DDEV project name (default: "default-project")
  HOST_PROJECT_ROOT       Host filesystem project root (default: /workspace)
  CONTAINER_PROJECT_ROOT  Container filesystem project root (default: /var/www/html)
  DDEV_SSH_USER           SSH user for container connections (preferred)
  DDEV_SSH_USER_FILE      Path to a file containing SSH user (fallback)
  SSH_USER                SSH user for container connections (fallback, default: $USER)
  SSH_STRICT_HOST_KEY_CHECKING  true/false toggle for SSH host key checking
`);
}

export function parseArgs(argv: string[]): BridgeConfig {
  const args = argv.slice(2); // Skip node and script path.

  let toolsConfigPath: string | undefined;
  let logLevel: BridgeConfig["logLevel"] = "info";
  let logFile: string | undefined = "/tmp/wdrmcp.log";
  let verboseLogging = false;
  let strictHostKeyChecking =
    (process.env.SSH_STRICT_HOST_KEY_CHECKING ?? "false").toLowerCase() === "true";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--tools-config":
        toolsConfigPath = args[++i];
        break;
      case "--log-level":
        logLevel = args[++i] as BridgeConfig["logLevel"];
        break;
      case "--log-file":
        logFile = args[++i];
        break;
      case "--verbose":
        verboseLogging = true;
        break;
      case "--strict-host-key-checking":
        strictHostKeyChecking = true;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  if (!toolsConfigPath) {
    console.error("Error: --tools-config is required");
    printUsage();
    process.exit(1);
  }

  // Load project .env early so placeholders in tools config can resolve
  // without requiring shell-level exports.
  loadProjectEnvFromToolsConfigPath(toolsConfigPath);

  // SSH user resolution strategy:
  // 1. Primary: DDEV_SSH_USER env var (explicit override)
  // 2. Secondary: Read from .env file (auto-detected in container)
  // 3. Fallback: SSH_USER or USER env vars (host-based defaults)
  let sshUser = process.env.DDEV_SSH_USER;
  
  if (!sshUser) {
    const sshUserFile =
      process.env.DDEV_SSH_USER_FILE ?? DEFAULT_SSH_USER_FILE;
    sshUser = readSshUserFromFile(sshUserFile);
  }
  
  if (!sshUser) {
    sshUser = process.env.SSH_USER ?? process.env.USER;
  }

  return {
    toolsConfigPath,
    ddevProject: process.env.DDEV_PROJECT ?? "default-project",
    logLevel,
    logFile,
    verboseLogging,
    hostProjectRoot: process.env.HOST_PROJECT_ROOT ?? "/workspace",
    containerProjectRoot:
      process.env.CONTAINER_PROJECT_ROOT ?? "/var/www/html",
    sshUser,
    strictHostKeyChecking,
  };
}
