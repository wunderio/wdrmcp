/**
 * CommandToolExecutor — executes shell commands via SSH
 * with argument substitution ({placeholder} syntax).
 */

import { execFile, ExecFileException } from "node:child_process";
import { z } from "zod";
import { TOOL_ERROR_SENTINEL } from "../constants.js";
import { getLogger } from "../logger.js";
import {
  addSingleQuotes,
  buildSshArgs,
  buildDdevEnvPrelude,
} from "../ssh-utils.js";
import {
  BaseToolConfigSchema,
  BaseToolValidationConfigSchema,
  BaseExecutorOptions,
  BaseToolConfig,
} from "../types/base.js";
import Validator from "../validators/validator.js";

import type { Args } from "../types/args.js";
import type {
  DisallowedCommand,
  ValidationRule,
  ValidatorInterface,
} from "../types/validation.js";
import type {
  ExecutorConfig,
  ToolExecutionResult,
  ToolExecutor,
  ToolExecutorStatic,
} from "../types/types.js";

/**
 * YAML tool config schema for command tools.
 */
export const CommandToolConfigSchema = z
  .object({
    ...BaseToolConfigSchema.shape,
    ...BaseToolValidationConfigSchema.shape,
    type: z.literal("command"),
    command_template: z.string(),
    project_root_dir: z.string().optional(),
    shell: z.string().optional(),
    ssh_target: z.string(),
    ssh_user: z.string().optional(),
    use_env_vars_in_remote: z.boolean().optional(),
    working_dir: z.string().optional(),
  })
  .strict();

/**
 * Tool configuration schema for a command-type tool (SSH execution).
 * Assumes SSH keys are configured and available (e.g. via homeadditions).
 */
export interface CommandToolConfig extends BaseToolConfig {
  type: "command";
  command_template: string;
  project_root_dir?: string;
  shell?: string;
  ssh_target: string; // e.g. "web" or "{DDEV_PROJECT}.ddev.site"
  ssh_user?: string; // e.g. "${DDEV_SSH_USER}", defaults to current user
  use_env_vars_in_remote?: boolean;
  working_dir?: string; // Optional working directory for execution
}

export interface CommandExecutorOptions extends BaseExecutorOptions {
  commandTemplate: string;
  host: string; // SSH target hostname
  projectRootDir?: string;
  shell?: string;
  sshUser?: string;
  strictHostKeyChecking?: boolean;
  type: string;
  useEnvVarsInRemote?: boolean;
  workingDir?: string;
}

export const CommandToolExecutor: ToolExecutorStatic = class CommandToolExecutor
  implements ToolExecutor
{
  private readonly commandTemplate: string;
  private readonly defaultArgs: Record<string, string | string[]>;
  private readonly host: string;
  private readonly projectRootDir: string;
  private readonly shell: string;
  private readonly sshUser?: string;
  private readonly strictHostKeyChecking: boolean;
  private readonly timeoutMs: number;
  private readonly type: string;
  private readonly useEnvVarsInRemote: boolean;
  private readonly validator: ValidatorInterface;
  private readonly workingDir?: string;

  constructor(options: CommandExecutorOptions) {
    this.commandTemplate = options.commandTemplate;
    this.defaultArgs = options.defaultArgs ?? {};
    this.host = options.host;
    this.projectRootDir = options.projectRootDir ?? "/var/www/html";
    this.shell = options.shell ?? "bash";
    this.sshUser = options.sshUser;
    this.strictHostKeyChecking = options.strictHostKeyChecking ?? false;
    this.timeoutMs = options.timeoutMs ?? 60_000; // Default to 60 seconds
    this.type = options.type;
    this.useEnvVarsInRemote = options.useEnvVarsInRemote ?? true;
    this.validator = new Validator(options);
    this.workingDir = options.workingDir;

    const log = getLogger();
    if (log.isVerbose()) {
      log.debug(`${this.type}: SSH user resolved to: ${this.sshUser}`);
    }
  }

  /**
   * Create a new instance of CommandToolExecutor from the provided configuration.
   * Validates the presence of required fields and resolves placeholders.
   *
   * @throws Error if required configuration is missing or invalid.
   */
  static create(
    executorConfig: ExecutorConfig<CommandToolConfig>,
  ): CommandToolExecutor {
    const log = getLogger();
    const {
      toolConfig: cfg,
      baseConfig,
      bridgeConfig,
      resolvePlaceholders,
    } = executorConfig;
    const { name } = baseConfig;
    const { sshUser: bridgeDefaultUser, strictHostKeyChecking } = bridgeConfig;
    const defaultUser = bridgeDefaultUser ?? process.env.USER;

    if (!cfg.command_template) {
      log.error(`Tool ${name}: missing command_template`);
      throw new Error(
        `Invalid configuration in ${name}: missing command_template`,
      );
    }
    if (!cfg.ssh_target) {
      log.error(`Tool ${name}: missing ssh_target`);
      throw new Error(`Invalid configuration in ${name}: missing ssh_target`);
    }

    // Note: These will throw if they end up containing unresolved placeholders.
    const sshTarget = resolvePlaceholders("ssh_target") ?? "web";
    const sshUser = resolvePlaceholders("ssh_user") ?? defaultUser;
    const projectRootDir = resolvePlaceholders("project_root_dir");
    const workingDir = resolvePlaceholders("working_dir");

    return new CommandToolExecutor({
      ...baseConfig,
      commandTemplate: cfg.command_template,
      defaultArgs: cfg.default_args,
      disallowedCommands: cfg.disallowed_commands,
      host: sshTarget,
      maxArgLength: cfg.max_arg_length,
      projectRootDir,
      shell: cfg.shell,
      sshUser,
      strictHostKeyChecking,
      type: cfg.type,
      timeoutMs: cfg.timeout ? cfg.timeout * 1000 : undefined,
      useEnvVarsInRemote: cfg.use_env_vars_in_remote,
      validationRules: cfg.validation_rules,
      workingDir,
    });
  }

  /**
   * Execute the command on the remote host via SSH.
   */
  async execute(args: Args): Promise<ToolExecutionResult> {
    const log = getLogger();

    // Merge with defaults.
    const mergedArgs: Args = {
      ...this.defaultArgs,
      ...args,
    };

    // Assemble command with validation.
    let command: string | undefined;
    try {
      command = this.validator.assembleCommand(
        this.commandTemplate,
        mergedArgs,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`${this.type}: Command assembly failed: ${errorMsg}`);
      return {
        content: `Command assembly failed: ${errorMsg}`,
        isError: true,
      };
    }

    if (log.isVerbose()) {
      log.debug(
        `${this.type}: Executing on ${this.host} as ${this.sshUser}, projectRootDir=${this.projectRootDir}, workingDir=${this.workingDir}, shell=${this.shell}`,
      );
    }

    const remoteScript: string = this.buildRemoteScript(command);

    const sshArgs = buildSshArgs({
      host: this.host,
      user: this.sshUser,
      strictHostKeyChecking: this.strictHostKeyChecking,
    });
    sshArgs.push("/usr/bin/env", addSingleQuotes(this.shell));

    if (log.isVerbose()) {
      log.debug(
        `${this.type}: Executing remote script via ssh ${this.sshUser ? `${this.sshUser}@${this.host}` : this.host}`,
      );
      log.debug(`${this.type}: Full remote script: ${remoteScript}`);
    }

    return new Promise((resolve, reject) => {
      // Capture the child process so we can write the script to its stdin.
      const sshProcess = execFile(
        "ssh",
        sshArgs,
        { maxBuffer: 10 * 1024 * 1024, timeout: this.timeoutMs },
        this.interpretToolExecutionResult(resolve, reject),
      );
      // Check that we got a child process and it has a stdin we can write to.
      if (sshProcess?.stdin === null) {
        reject(
          new Error(
            `${this.type}: child process does not have stdin! This is a bug in wdrmcp.`,
          ),
        );
        return;
      }
      // Write the remote script to the SSH process's stdin,
      // then close it to signal we're done.
      sshProcess.stdin?.write(remoteScript);
      sshProcess.stdin?.end();
    });
  }

  /**
   * Interpret the result of the SSH command execution, resolving or rejecting
   * the promise accordingly.
   */
  interpretToolExecutionResult(
    resolve: (value: ToolExecutionResult) => void,
    reject: (reason?: any) => void,
  ) {
    const log = getLogger();
    return (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ): void => {
      if (error) {
        const cleanedError = (stderr?.trim() || error.message).trim();
        log.error(
          `${this.type}: Command failed on ${this.host}: ${cleanedError}`,
        );
        if (log.isVerbose()) {
          log.debug(`${this.type}: Raw stderr: ${stderr}`);
        }
        reject(new Error(cleanedError));
        return;
      }

      // Check if the exit status trailer caught and reported an error.
      // This means the SSH command was ok, but the remote command failed,
      // meaning that the tool command exited with a non-zero exit code.
      //
      // Note that the sentinel will be in stdout, not stderr, because
      // the script execution always exits 0 unless something is seriously
      // wrong.
      else if (stdout.includes(TOOL_ERROR_SENTINEL)) {
        const errorPart = stdout.split(TOOL_ERROR_SENTINEL)[1].trim();
        let errorInfo = { exit: -1, error: "Unknown error" };
        try {
          const parsed = errorPart.split("\n");
          // Remove the exit code, it is expected to be on the first line.
          const exitCode = parsed.shift();
          if (exitCode) {
            errorInfo.exit = parseInt(exitCode);
          }
          // The rest of the lines will the stderr from the command.
          if (parsed.length > 0) {
            errorInfo.error = parsed.join("\n");
          }
        } catch (parseError) {
          // Report parsing errors as bugs.
          log.error(
            `${this.type}: Failed to parse error info from stderr on ${this.host}: ${parseError}`,
          );
          log.debug(`${this.type}: Raw stderr: ${stderr}`);
          reject(
            new Error(
              `Remote command failed with unparseable error info: ${errorPart}`,
            ),
          );
          return;
        }

        // Report unexpected remote command failure.
        log.error(
          `${this.type}: Remote command failed on ${this.host} with exit code ${errorInfo.exit}: ${errorInfo.error}`,
        );
        if (log.isVerbose()) {
          log.debug(`${this.type}: Raw stderr: ${stderr}`);
        }
        reject(
          new Error(
            `Remote command failed with exit code ${errorInfo.exit}: ${errorInfo.error}`,
          ),
        );
        return;
      }

      const trimmedOutput = stdout.trim();

      log.info(`${this.type}: Command succeeded on ${this.host}`);

      // Add success message for empty outputs.
      if (trimmedOutput.length === 0) {
        resolve({ content: "Command completed successfully (no output)" });
        return;
      }

      resolve({
        content: trimmedOutput,
      });
      return;
    };
  }

  isTimeout(durationMs: number): boolean {
    return durationMs >= this.timeoutMs;
  }

  getValidator(): ValidatorInterface {
    return this.validator;
  }

  /**
   * Build a script to execute the given command on the remote host.
   *
   * The trailer will capture the exit code and the stderr output of the command
   * and make sure the executed command always exits with a zero exit code.
   *
   * If exit code is non-zero, the script will report the exit code and stderr
   * in a structured way that can be parsed by the caller.
   *
   * This is necessary, because otherwise bash and SSH will just report
   * "Command failed" on the entire SSH+bash command without any actual error
   * message or exit code, making debugging of some tools very difficult.
   * We could use "|| true" in commands, but that would swallow all errors,
   * which also makes debugging difficult.
   *
   * Note: Redirection from /dev/null is necessary to properly close
   * file handles over the SSH connection. Without it, the handles never close,
   * and the tool call will eventually time out.
   *
   * @returns {string}
   *   A script ready to be piped into a SSH session.
   */
  private buildRemoteScript(command: string): string {
    const { useEnvVarsInRemote, projectRootDir, shell, workingDir } = this;
    const errorLogFile = "/tmp/tool_stderr.log";
    return `

#!/usr/bin/env ${shell}

# Note: cannot use -e flag or a failing command will abort the entire script.
set -uo pipefail

${useEnvVarsInRemote ? buildDdevEnvPrelude(projectRootDir) : ""}

(
  ${workingDir ? `cd ${addSingleQuotes(workingDir)} &&` : ""}
  ${command}
) 2>${errorLogFile} </dev/null

# Trailer to capture exit code and stderr from the command.
TOOL_EXIT_CODE=$?
if [ $TOOL_EXIT_CODE -ne 0 ]; then
  echo '${TOOL_ERROR_SENTINEL}';
  echo "$TOOL_EXIT_CODE";
  cat ${errorLogFile};
fi
exit 0

  `.trim();
  }
};
