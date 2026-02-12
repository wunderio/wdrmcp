/**
 * Docker executor — runs commands in Docker containers with security validation.
 *
 * Container ownership is validated once and cached. UID resolution is cached.
 * Static safety checks (shell name, etc.) happen at construction time.
 */

import { execFile } from "node:child_process";
import { getLogger } from "./logger.js";

/** Characters considered dangerous in command arguments. */
const DANGEROUS_CHARS = [";", "|", "&", ">", "<", "$", "`", "\n", "\r"];

/** Cache of validated containers: "container:project" → true. */
const validatedContainers = new Map<string, boolean>();

/** Cache of resolved UIDs: "container:path" → uid string. */
const uidCache = new Map<string, string>();

export interface DockerExecOptions {
  container: string;
  command: string[];
  user?: string;
  shell?: string;
}

/**
 * Validate that a container belongs to the expected DDEV project.
 * Result is cached — subsequent calls for the same container return immediately.
 */
export async function validateContainer(
  container: string,
  ddevProject: string,
): Promise<void> {
  const cacheKey = `${container}:${ddevProject}`;
  if (validatedContainers.has(cacheKey)) return;

  const log = getLogger();
  log.debug(`Validating container "${container}" for project "${ddevProject}"`);

  try {
    const format = `{{index .Config.Labels "com.ddev.site-name"}}`;
    const labelValue = (
      await execCommand("docker", ["inspect", "--format", format, container])
    ).trim();

    if (ddevProject !== "default-project" && labelValue !== ddevProject) {
      throw new Error(
        `Container "${container}" belongs to "${labelValue}", not "${ddevProject}"`,
      );
    }
  } catch (e) {
    if ((e as Error).message.includes("belongs to")) throw e;
    // Container doesn't exist yet or docker inspect failed — warn but allow.
    log.warn(`Container validation warning: ${(e as Error).message}`);
  }

  validatedContainers.set(cacheKey, true);
  log.debug(`Container "${container}" validated (cached)`);
}

/**
 * Validate that static values don't contain dangerous shell characters.
 * Call once at construction time, not per-execution.
 */
export function validateStaticSafety(values: string[]): void {
  for (const val of values) {
    for (const char of DANGEROUS_CHARS) {
      if (val.includes(char)) {
        throw new Error(
          `Dangerous character "${char}" in static value: "${val}"`,
        );
      }
    }
  }
}

/**
 * Resolve `auto:uid-from-path` user syntax to an actual UID.
 * Cached per container+path combination.
 *
 * Format: "auto:uid-from-path" or "auto:uid-from-path:/var/www/html"
 */
export async function resolveContainerUser(
  user: string,
  container: string,
): Promise<string> {
  if (!user.startsWith("auto:uid-from-path")) return user;

  const parts = user.split(":");
  const targetPath = parts.length > 2 ? parts[2] : "/var/www/html";
  const cacheKey = `${container}:${targetPath}`;

  const cached = uidCache.get(cacheKey);
  if (cached) return cached;

  const log = getLogger();
  try {
    const result = await dockerExec({
      container,
      command: [`stat -c %u ${targetPath}`],
      user: "root",
      shell: "/bin/sh",
    });
    const uid = result.trim();
    if (uid) {
      log.info(`Resolved auto:uid-from-path:${targetPath} → UID ${uid} (cached)`);
      uidCache.set(cacheKey, uid);
      return uid;
    }
  } catch (e) {
    log.warn(`Error resolving UID: ${e}. Falling back to www-data`);
  }

  uidCache.set(cacheKey, "www-data");
  return "www-data";
}

/**
 * Execute a command inside a Docker container.
 */
export async function dockerExec(options: DockerExecOptions): Promise<string> {
  const { container, command, user, shell = "/bin/bash" } = options;

  const dockerArgs = ["exec"];
  if (user) dockerArgs.push("-u", user);
  dockerArgs.push(container, shell, "-c", command.join(" "));

  return execCommand("docker", dockerArgs);
}

/**
 * Async wrapper around child_process.execFile.
 * Wraps docker commands with 'sg docker -c' to ensure docker group access.
 */
function execCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let finalCmd = cmd;
    let finalArgs = args;
    
    // Wrap docker commands with sg to activate docker group
    if (cmd === "docker") {
      finalCmd = "sg";
      // Build the full docker command and properly quote arguments
      const dockerCmd = [cmd, ...args].map(arg => {
        // Quote arguments that contain spaces or special chars
        if (arg.includes(' ') || arg.includes('"') || arg.includes("'")) {
          return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return arg;
      }).join(' ');
      finalArgs = ["docker", "-c", dockerCmd];
    }
    
    execFile(
      finalCmd,
      finalArgs,
      { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Command failed: ${cmd} ${args.join(" ")}\n${stderr?.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}
