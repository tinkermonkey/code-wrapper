export interface Session {
  /** App-defined key (e.g. CallSid, user ID, thread ID, project path) */
  key: string;
  /**
   * The CLI-assigned session ID returned in the 'done' event.
   * Undefined until the first successful turn completes.
   * Pass this as sessionId in ProcessOptions on subsequent turns.
   */
  cliSessionId?: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  lastActiveAt: string;
  /**
   * True until recordCliSessionId() is called after the first successful turn.
   * Controls whether CliProcess uses --session-id (first) or --resume (subsequent).
   */
  isFirst: boolean;
}
