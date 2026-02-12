/**
 * Logger for MCP servers (stdout is reserved for JSON-RPC).
 * Writes WARN/ERROR to stderr, all levels to log file if configured.
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

    private formatArgs(args: unknown[]): string {
        if (args.length === 0) return "";
        return ` ${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}`;
    }

    private log(level: LogLevel, message: string, ...args: unknown[]): void {
        if (LOG_LEVELS[level] < this.level) return;

        const timestamp = new Date().toISOString();
        const levelLabel = level.toUpperCase();
        const argsText = this.formatArgs(args);
        const fileFormatted = `${timestamp} - wdrmcp - ${levelLabel} - ${message}${argsText}`;
        const stderrFormatted = `[wdrmcp] ${level}: ${message}${argsText}`;

        // Write WARN/ERROR to stderr for VSCode logs; keep INFO/DEBUG in file only.
        if (level === "warn" || level === "error") {
            console.error(stderrFormatted);
        }

        // Optionally write to file.
        if (this.logFile) {
            try {
                const fileMsg = `${fileFormatted}\n`;
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