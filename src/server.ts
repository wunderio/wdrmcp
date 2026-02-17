/**
 * MCP Server — registers tools from the ToolRegistry using the official SDK.
 *
 * Note: McpServer.registerTool() requires Zod schemas, so we convert the
 * JSON Schema from YAML configs to Zod. This is the SDK's requirement —
 * the low-level Server class is deprecated.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { getLogger } from "./logger.js";
import { ToolRegistry } from "./registry.js";
import type { JsonSchemaProperty } from "./types.js";

/** Convert a JSON Schema property to a Zod schema. */
function toZod(prop: JsonSchemaProperty): z.ZodTypeAny {
  const base = (() => {
    switch (prop.type) {
      case "string": return prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
      case "number": case "integer": return z.number();
      case "boolean": return z.boolean();
      case "array": return z.array(z.unknown());
      case "object": return z.record(z.unknown());
      default: return z.unknown();
    }
  })();
  return prop.description ? base.describe(prop.description) : base;
}

/** Convert JSON Schema properties + required to a ZodRawShape. */
function toZodShape(
  schema?: { properties?: Record<string, JsonSchemaProperty>; required?: string[] },
): ZodRawShape {
  if (!schema?.properties) return {};

  const required = new Set(schema.required ?? []);
  const shape: ZodRawShape = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    shape[key] = required.has(key) ? toZod(prop) : toZod(prop).optional();
  }
  return shape;
}

/** Create and configure the MCP server with all tools from the registry. */
export function createMcpServer(registry: ToolRegistry): McpServer {
  const log = getLogger();
  const server = new McpServer({ name: "wdrmcp", version: "0.1.0" });

  for (const [toolName, { config }] of registry.getAllTools()) {
    server.tool(
      toolName,
      config.description ?? "Tool with no description",
      toZodShape(config.input_schema),
      async (args) => {
        const startTime = Date.now();
        log.info(`========== TOOL START: ${toolName} ==========`);
        if (log.isVerbose()) {
          log.info(`Tool input arguments: ${JSON.stringify(args)}`);
          log.debug(`Tool config: ${JSON.stringify(config)}`);
        }
        
        try {
          const result = await registry.executeTool(toolName, args as Record<string, unknown>);
          const duration = Date.now() - startTime;
          
          if (result.isError) {
            log.error(`TOOL RESULT (${duration}ms, ERROR): ${toolName}`);
            if (log.isVerbose()) {
              log.info(`TOOL OUTPUT (error, ${result.content.length} chars):`);
              log.info(result.content);
            }
          } else {
            log.info(`TOOL RESULT (${duration}ms, SUCCESS): ${toolName}`);
            if (log.isVerbose()) {
              log.info(`TOOL OUTPUT (${result.content.length} chars):`);
              log.info(result.content);
            }
          }
          log.info(`========== TOOL END: ${toolName} ==========`);
          
          return {
            content: [{ type: "text" as const, text: result.content }],
            isError: result.isError,
          };
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`TOOL EXCEPTION (${duration}ms): ${toolName} - ${errorMsg}`);
          if (log.isVerbose()) {
            log.error(`Exception stack: ${error instanceof Error ? error.stack : ""}`);
          }
          log.info(`========== TOOL END: ${toolName} (EXCEPTION) ==========`);
          return {
            content: [{ type: "text" as const, text: `Tool execution failed: ${errorMsg}` }],
            isError: true,
          };
        }
      },
    );
  }

  log.info(`MCP server configured with ${registry.getToolNames().length} tools`);
  return server;
}
