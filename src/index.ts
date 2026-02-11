#!/usr/bin/env node

/**
 * WDRMCP — CLI entry point.
 *
 * A generic MCP server that dynamically loads tool definitions from YAML
 * configuration files and executes them in Docker containers or proxies
 * them to remote MCP servers.
 *
 * Usage:
 *   wdrmcp --tools-config /path/to/tools-config
 *   npx @wunderio/wdrmcp --tools-config /path/to/tools-config
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "./config.js";
import { initLogger, getLogger } from "./logger.js";
import { ToolRegistry } from "./registry.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  // Parse CLI arguments.
  const config = parseArgs(process.argv);

  // Initialize logger (stderr only — stdout is reserved for JSON-RPC).
  initLogger(config.logLevel, config.logFile);
  const log = getLogger();

  try {
    log.info("Starting WDRMCP (YAML Configuration MCP Server)");
    log.info(`Tools config path: ${config.toolsConfigPath}`);
    log.info(`DDEV project: ${config.ddevProject}`);

    // Load tools from YAML configuration files.
    const registry = new ToolRegistry(config.toolsConfigPath, config);
    const toolCount = await registry.loadTools();

    if (toolCount === 0) {
      log.warn("No tools loaded! Check the tools-config directory.");
    }

    // Create and start the MCP server.
    const server = createMcpServer(registry);
    const transport = new StdioServerTransport();
    await server.connect(transport);

    log.info("WDRMCP server running on stdio");
  } catch (e) {
    log.error(`Fatal error: ${e}`);
    process.exit(1);
  }
}

main();
