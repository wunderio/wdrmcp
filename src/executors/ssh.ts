import { execFile } from "node:child_process";
import { getLogger } from "../logger.js";
import type { ContainerExecutor } from "../types.js";

export interface SshArgOptions {
  host: string;
  user?: string;
  strictHostKeyChecking?: boolean;
}

/**
 * Build base SSH arguments (host key checking options + destination).
 * Shared by SshExecutor (command execution) and McpStdioExecutor (stdio transport).
 */
export function buildSshArgs(options: SshArgOptions): string[] {
  const args = ["-o", "LogLevel=ERROR"];
  if (options.strictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=yes");
  } else {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }
  const destination = options.user ? `${options.user}@${options.host}` : options.host;
  args.push(destination);
  return args;
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build a shell prelude that exports DDEV environment variables (DB_HOST, etc.)
 * from .ddev/config.yaml. SSH sessions don't inherit container env vars, so
 * commands that need a Drupal bootstrap (like drush) require this.
 */
export function buildDdevEnvPrelude(workingDir?: string): string {
  if (!workingDir) {
    return "";
  }

  const baseDir = workingDir.replace(/\/$/, "");
  const configPath = escapeShellArg(`${baseDir}/.ddev/config.yaml`);

  return `if [ -f ${configPath} ]; then while IFS= read -r kv; do [ -n "$kv" ] && export "$kv"; done < <(awk -F'- ' '/- (DB_(HOST|NAME|USER|PASS)|HASH_SALT|ENVIRONMENT_NAME)=/ {print $2}' ${configPath}); fi; `;
}

/**
 * Executes commands on SSH hosts.
 * Assumes SSH keys are configured and available (e.g. via homeadditions).
 */
export class SshExecutor implements ContainerExecutor {
  private readonly defaultUser: string | undefined;
  private readonly strictHostKeyChecking: boolean;

  constructor(options?: { defaultUser?: string; strictHostKeyChecking?: boolean }) {
    this.defaultUser = options?.defaultUser ?? process.env.USER;
    this.strictHostKeyChecking = options?.strictHostKeyChecking ?? false;
  }

  async execute(options: {
    host: string;
    command: string[];
    user?: string;
    shell?: string;
    workingDir?: string;
  }): Promise<string> {
    const { host, command, user, shell = "/bin/bash", workingDir } = options;
    const log = getLogger();
    const startTime = Date.now();

    if (log.isVerbose()) {
      log.debug(`SSH: Connecting to ${host}, workingDir=${workingDir || "/"}, shell=${shell}`);
    }

    // Determine the SSH user to connect as
    const sshUser = this.resolveSshUser(user);
    if (log.isVerbose()) {
      log.debug(`SSH: User resolved to: ${sshUser || "default"}`);
    }

    // Build the full command, optionally with working directory change
    let remoteCmd = command.join(" ");
    if (workingDir) {
      remoteCmd = `cd ${this.escapeShellArg(workingDir)} && ${remoteCmd}`;
    }

    const envPrelude = buildDdevEnvPrelude(workingDir);
    if (envPrelude) {
      remoteCmd = `${envPrelude}${remoteCmd}`;
      if (log.isVerbose()) {
        log.debug(`SSH: Adding DDEV env prelude`);
      }
    }

    if (log.isVerbose()) {
      log.debug(`SSH: Full remote command: ${remoteCmd.substring(0, 200)}${remoteCmd.length > 200 ? "..." : ""}`);
    }

    // Quote the full command so bash -c receives it as a single string
    const escapedCmd = this.escapeShellCommand(remoteCmd);
    
    const shellFlag = "-c";

    const sshArgs = buildSshArgs({
      host,
      user: sshUser,
      strictHostKeyChecking: this.strictHostKeyChecking,
    });
    sshArgs.push(shell, shellFlag, escapedCmd);

    if (log.isVerbose()) {
      log.debug(`SSH: Executing ssh ${sshUser ? `${sshUser}@${host}` : host} ${shell} -c '<command>'`);
    }

    return new Promise((resolve, reject) => {
      execFile(
        "ssh",
        sshArgs,
        { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
        (error, stdout, stderr) => {
          const duration = Date.now() - startTime;
          
          if (error) {
            const cleanedError = (stderr?.trim() || error.message).trim();
            log.error(`SSH: Command failed on ${host} (${duration}ms): ${cleanedError}`);
            if (log.isVerbose()) {
              log.debug(`SSH: Raw stderr: ${stderr}`);
            }
            reject(new Error(cleanedError));
            return;
          }
          
          log.info(`SSH: Command succeeded on ${host} (${duration}ms)`);
          resolve(stdout);
        },
      );
    });
  }

  /**
   * Resolve the SSH user to connect as.
   * - If user is a simple string (username), use it
   * - Otherwise use configured default or $USER env var
   */
  private resolveSshUser(user: string | undefined): string | undefined {
    if (user) {
      return user;
    }
    return this.defaultUser;
  }

  /**
   * Escape a shell command for safe execution via SSH.
   * Wraps the entire command in single quotes and escapes any embedded single quotes.
   */
  private escapeShellCommand(cmd: string): string {
    // Escape single quotes by replacing ' with '\''
    const escaped = cmd.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }

  private escapeShellArg(value: string): string {
    return escapeShellArg(value);
  }
}

