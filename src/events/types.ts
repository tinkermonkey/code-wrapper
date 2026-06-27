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
}

export type ErrorCode =
  | 'idle_timeout'   // stdout silence exceeded idleTimeout
  | 'max_timeout'    // wall-clock ceiling exceeded
  | 'nonzero_exit'   // process exited with non-zero code
  | 'rate_limit'     // rate limit hit (inline event or stderr pattern)
  | 'spawn_error'    // process could not be started
  | 'stale_session'  // stderr: "No conversation found with session ID"
  | 'parse_error'    // line starts with '{' but is not valid JSON
  | 'cli_error'      // inline error/error_detail/error_event from the CLI stream
  | 'aborted';       // cancelled via AbortSignal

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
