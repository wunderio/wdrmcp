# @wunderio/wdrmcp

A generic MCP (Model Context Protocol) server that dynamically loads tool definitions from YAML configuration files and executes them in Docker containers or proxies them to remote MCP servers.

Built with the [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Features

- **YAML-driven tool definitions** — define tools declaratively, no code changes needed
- **Docker container execution** — run commands in Docker containers with security validation
- **MCP server proxying** — proxy tool calls to remote MCP servers via HTTP JSON-RPC
- **Dynamic tool discovery** — automatically fetch and expose tools from remote MCP servers
- **Security** — container ownership validation, command injection prevention, argument validation
- **DDEV integration** — built-in support for DDEV container naming and project scoping

## Installation

```bash
npm install -g @wunderio/wdrmcp
```

Or use directly with npx:

```bash
npx @wunderio/wdrmcp --tools-config /path/to/tools-config
```

## Usage

### CLI

```bash
wdrmcp --tools-config /path/to/tools-config [options]
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--tools-config <path>` | Path to YAML tool config directory | *(required)* |
| `--log-level <level>` | Log level (debug, info, warn, error) | `info` |
| `--log-file <path>` | Log file path | `/tmp/wdrmcp.log` |

**Environment variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `DDEV_PROJECT` | DDEV project name | `default-project` |
| `HOST_PROJECT_ROOT` | Host filesystem project root | `/workspace` |
| `CONTAINER_PROJECT_ROOT` | Container filesystem project root | `/var/www/html` |

### VS Code / GitHub Copilot Configuration

```json
{
  "servers": {
    "wdrmcp": {
      "command": "npx",
      "args": ["-y", "@wunderio/wdrmcp", "--tools-config", "/path/to/tools-config"],
      "env": {
        "DDEV_PROJECT": "my-project"
      }
    }
  }
}
```

## Tool Configuration Format

Tools are defined in YAML files within the tools-config directory. Each file must contain a `tools` array.

### Command Tool

Executes shell commands in Docker containers:

```yaml
tools:
  - name: my_tool
    enabled: true
    description: "What this tool does"
    type: command
    command_template: "my-command {arg1} {arg2}"
    container: "ddev-{DDEV_PROJECT}-web"
    user: "www-data"
    shell: "/bin/bash"
    default_args:
      arg2: "default-value"
    disallowed_commands:
      - "rm"
      - "shutdown"
    validation_rules:
      - pattern: "dangerous-pattern"
        message: "This pattern is not allowed"
    input_schema:
      type: object
      properties:
        arg1:
          type: string
          description: "First argument"
      required:
        - arg1
```

### MCP Server Proxy Tool

Proxies tool calls to a remote MCP server:

```yaml
tools:
  - name: remote_tools
    enabled: true
    description: "Remote MCP server"
    type: mcp_server
    server_url: "http://localhost:8080"
    expose_remote_tools: true
    tool_prefix: "remote_"
    timeout: 30
    auth_token: "my-token"
    verify_ssl: true
```

## Architecture

```
src/
├── index.ts           # CLI entry point
├── server.ts          # MCP server setup (tool registration with Zod schemas)
├── registry.ts        # Tool registry (YAML loading, executor creation)
├── executors/
│   ├── base.ts        # Base executor interface
│   ├── command.ts     # Docker container command executor
│   └── mcp-proxy.ts   # Remote MCP server proxy executor
├── docker.ts          # Docker exec & container validation
├── config.ts          # CLI argument parsing
├── logger.ts          # Stderr-only logger
└── types.ts           # TypeScript type definitions
```

## License

MIT
