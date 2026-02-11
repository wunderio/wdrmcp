/**
 * CLI argument parsing and configuration loading.
 */

import type { BridgeConfig } from "./types.js";

function printUsage(): void {
  console.error(`
Usage: wdrmcp --tools-config <path> [options]

Options:
  --tools-config <path>   Path to directory containing YAML tool configuration files (required)
  --log-level <level>     Log level: debug, info, warn, error (default: info)
  --log-file <path>       Path to log file (default: /tmp/wdrmcp.log)
  --help                  Show this help message

Environment variables:
  DDEV_PROJECT            DDEV project name (default: "default-project")
  HOST_PROJECT_ROOT       Host filesystem project root (default: /workspace)
  CONTAINER_PROJECT_ROOT  Container filesystem project root (default: /var/www/html)
`);
}

export function parseArgs(argv: string[]): BridgeConfig {
  const args = argv.slice(2); // Skip node and script path.

  let toolsConfigPath: string | undefined;
  let logLevel: BridgeConfig["logLevel"] = "info";
  let logFile: string | undefined = "/tmp/wdrmcp.log";

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

  return {
    toolsConfigPath,
    ddevProject: process.env.DDEV_PROJECT ?? "default-project",
    logLevel,
    logFile,
    hostProjectRoot: process.env.HOST_PROJECT_ROOT ?? "/workspace",
    containerProjectRoot:
      process.env.CONTAINER_PROJECT_ROOT ?? "/var/www/html",
  };
}
