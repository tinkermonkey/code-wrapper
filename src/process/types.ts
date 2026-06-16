export type CliBackend = 'claude' | 'copilot';

export interface ProcessOptions {
  /** Working directory for the CLI subprocess */
  cwd: string;
  /** Prompt delivered via stdin */
  prompt: string;
  /** Agent or skill to invoke (e.g. 'dr-architect') */
  agent?: string;
  /** Pass --dangerously-skip-permissions */
  skipPermissions?: boolean;
  /** Path to an MCP config JSON file (--mcp-config) */
  mcpConfigPath?: string;
  /**
   * CLI-level session ID for conversation continuity.
   *
   * First message in a session: passed as --session-id (starts a new CLI
   * session with a known, traceable ID).
   *
   * Subsequent messages: passed as --resume (continues the existing session).
   *
   * Obtain the CLI-assigned ID from the 'done' event's sessionId field and
   * store it in SessionManager via recordCliSessionId().
   */
  sessionId?: string;
  /** Controls --session-id vs --resume. True for the first message. Default: true */
  isFirstMessage?: boolean;
  /** Seconds of stdout silence before SIGTERM. Default: 300 */
  idleTimeout?: number;
  /** Hard ceiling in seconds regardless of activity. Default: 3600 */
  maxTimeout?: number;
}
