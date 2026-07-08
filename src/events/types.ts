export type ClaudeEventType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'progress'
  | 'ready'
  | 'retry'
  | 'done'
  | 'error'
  | 'raw';

export interface BaseEvent {
  /** Monotonic across all events in a run — safe for replay and deduplication */
  seq: number;
  timestamp: number;
  type: ClaudeEventType;
}

export interface TextEvent extends BaseEvent {
  type: 'text';
  text: string;
}

export interface ThinkingEvent extends BaseEvent {
  type: 'thinking';
  /** Extended thinking content from the model */
  thinking: string;
}

export interface ToolUseEvent extends BaseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  /** Full tool input as received from the CLI */
  input: unknown;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolUseId: string;
  isError: boolean;
  /** Full combined text output from the tool result content blocks */
  output: string;
}

export interface ProgressEvent extends BaseEvent {
  type: 'progress';
  /** Seconds elapsed since process start */
  elapsed: number;
}

export interface ReadyEvent extends BaseEvent {
  type: 'ready';
  /** CLI-assigned session ID — available at process start, before the done event */
  sessionId: string;
  /** Model being used for this run */
  model?: string;
  /** Names of tools available to the agent */
  tools?: string[];
}

export interface RetryEvent extends BaseEvent {
  type: 'retry';
  /** Attempt number (1-based) */
  attempt: number;
  /** Delay before this retry in milliseconds */
  delayMs?: number;
  /** Error message that triggered the retry */
  error?: string;
}

export interface DoneEvent extends BaseEvent {
  type: 'done';
  /** CLI-assigned session ID — store this and pass as sessionId on the next turn */
  sessionId: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  /**
   * Claude's own final summary/answer text (`result.result`) — distinct from
   * the streamed `assistant` text blocks. Claude-only: Copilot's ACP
   * `session/prompt` ack carries no equivalent field, and its final answer is
   * already fully covered by the streamed `TextEvent`s, so this is left
   * unset rather than populated from something that isn't actually there.
   */
  resultText?: string;
  /** Claude's `result.is_error` — whether the turn ended in an error state */
  isError?: boolean;
  /** Claude's `result.duration_ms` — wall-clock duration of the turn */
  durationMs?: number;
  /** Claude's `result.total_cost_usd` */
  totalCostUsd?: number;
  /** Claude's `result.num_turns` */
  numTurns?: number;
  /**
   * Copilot ACP's `session/prompt` ack `result.stopReason` (e.g. `'end_turn'`).
   * Copilot-only — Claude's `result` event has no equivalent field.
   */
  stopReason?: string;
}

export type ErrorCode =
  | 'idle_timeout'    // stdout silence exceeded idleTimeout
  | 'max_timeout'     // wall-clock ceiling exceeded
  | 'nonzero_exit'    // process exited with non-zero code
  | 'rate_limit'      // rate limit hit (inline event or stderr pattern)
  | 'spawn_error'     // process could not be started (ENOENT, EACCES, etc.)
  | 'internal_error'  // unexpected exception in generator body (programmer bug)
  | 'stale_session'   // stderr: "No conversation found with session ID"
  | 'parse_error'     // line starts with '{' but is not valid JSON
  | 'cli_error'       // inline error/error_detail/error_event from the CLI stream
  | 'aborted';        // cancelled via AbortSignal

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  code: ErrorCode;
  detail: string;
  exitCode?: number;
}

export interface RawEvent extends BaseEvent {
  type: 'raw';
  /** The 'type' field from the raw CLI event */
  rawType: string;
  /** The 'subtype' field if present */
  rawSubtype?: string;
  /** The full raw parsed JSON object — nothing is discarded */
  data: unknown;
}

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export type ClaudeEvent =
  | TextEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | ProgressEvent
  | ReadyEvent
  | RetryEvent
  | DoneEvent
  | ErrorEvent
  | RawEvent;
