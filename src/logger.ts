/**
 * Logger that writes exclusively to stderr (stdout is reserved for JSON-RPC).
 * Optionally writes to a log file.
 */

import { appendFileSync, writeFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: number;
  private logFile?: string;

  constructor(level: LogLevel = "info", logFile?: string) {
    this.level = LOG_LEVELS[level];
    this.logFile = logFile;

    // Truncate log file on start.
    if (this.logFile) {
      try {
        writeFileSync(this.logFile, "");
      } catch {
        // Ignore if we can't create the log file.
      }
    }
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LOG_LEVELS[level] < this.level) return;

    const timestamp = new Date().toISOString();
    const formatted = `${timestamp} - wdrmcp - ${level.toUpperCase()} - ${message}`;

    // Always write to stderr (never stdout).
    console.error(formatted, ...args);

    // Optionally write to file.
    if (this.logFile) {
      try {
        const fileMsg =
          args.length > 0
            ? `${formatted} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`
            : `${formatted}\n`;
        appendFileSync(this.logFile, fileMsg);
      } catch {
        // Ignore file write errors.
      }
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log("info", message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log("error", message, ...args);
  }
}

/** Singleton logger instance — call `initLogger()` to configure. */
let logger = new Logger();

export function initLogger(level: LogLevel = "info", logFile?: string): Logger {
  logger = new Logger(level, logFile);
  return logger;
}

export function getLogger(): Logger {
  return logger;
}
