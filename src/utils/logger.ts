/**
 * Simple structured logger
 *
 * Writes ISO-timestamped log lines to the appropriate console stream.
 * The active log level is read from `config.server.logLevel` at startup.
 * Level hierarchy (lowest → highest): debug → info → warn → error.
 */

import { config } from '../config.js';

/** Recognised log severity levels. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Numeric weights used to compare log levels.
 * A message is emitted only when its level weight ≥ the configured minimum.
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Minimal structured logger that writes to the Node.js console.
 *
 * Each line has the form:
 * ```
 * [ISO-TIMESTAMP] [LEVEL] message ...args
 * ```
 * Object arguments are serialised via `JSON.stringify`.
 */
class Logger {
  private readonly level: LogLevel;

  /**
   * @param level - Minimum level to emit. Messages below this level are suppressed.
   */
  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  /** Returns `true` when `level` is at or above the configured minimum. */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  /**
   * Build the formatted log string.
   *
   * @param level - Severity label.
   * @param message - Primary log message.
   * @param args - Additional values appended after the message.
   * @returns Formatted log line ready for console output.
   */
  private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ' ' + args.map(arg =>
      (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)),
    ).join(' ') : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${formattedArgs}`;
  }

  /**
   * Emit a debug-level message.
   * Suppressed unless the configured level is `'debug'`.
   */
  public debug(message: string, ...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, ...args));
    }
  }

  /** Emit an informational message. */
  public info(message: string, ...args: any[]): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, ...args));
    }
  }

  /** Emit a warning. */
  public warn(message: string, ...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, ...args));
    }
  }

  /** Emit an error message. */
  public error(message: string, ...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, ...args));
    }
  }
}

/** Singleton logger instance, configured from `config.server.logLevel`. */
export const logger = new Logger(config.server.logLevel);
