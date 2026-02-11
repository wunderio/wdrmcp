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
        log.info(`Calling tool: ${toolName}`);
        const result = await registry.executeTool(toolName, args as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: result.content }],
          isError: result.isError,
        };
      },
    );
  }

  log.info(`MCP server configured with ${registry.getToolNames().length} tools`);
  return server;
}
