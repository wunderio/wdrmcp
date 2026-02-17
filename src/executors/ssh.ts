import { execFile } from "node:child_process";
import { getLogger } from "../logger.js";
import type { ContainerExecutor } from "../types.js";

/**
 * Executes commands on SSH hosts.
 * Assumes SSH keys are configured and available (e.g. via homeadditions).
 */
export class SshExecutor implements ContainerExecutor {
  private readonly defaultUser: string | undefined;

  constructor(defaultUser?: string) {
    this.defaultUser = defaultUser ?? process.env.USER;
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
      remoteCmd = `cd ${workingDir} && ${remoteCmd}`;
    }

    const envPrelude = this.buildDdevEnvPrelude(workingDir);
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
    
    // Build SSH destination: "user@hostname" or just "hostname"
    const sshDestination = sshUser ? `${sshUser}@${host}` : host;

    const shellFlag = "-c";

    const sshArgs = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      sshDestination,
      shell,
      shellFlag,
      escapedCmd,
    ];

    if (log.isVerbose()) {
      log.debug(`SSH: Executing ssh ${sshDestination} ${shell} -c '<command>'`);
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

  private buildDdevEnvPrelude(workingDir?: string): string {
    if (!workingDir) {
      return "";
    }

    const baseDir = workingDir.replace(/\/$/, "");
    const configPath = this.escapeShellCommand(`${baseDir}/.ddev/config.yaml`);

    return `if [ -f ${configPath} ]; then export $(awk -F'- ' '/- (DB_(HOST|NAME|USER|PASS)|HASH_SALT|ENVIRONMENT_NAME)=/ {print $2}' ${configPath} | xargs); fi; `;
  }
}

