export type ClaudeEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'progress'
  | 'done'
  | 'error';

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
  | 'rate_limit'     // stderr contained a rate-limit reset message
  | 'spawn_error'    // process could not be started
  | 'stale_session'  // stderr: "No conversation found with session ID"
  | 'parse_error'    // line starts with '{' but is not valid JSON
  | 'cli_error';     // inline error/error_detail/error_event from the CLI stream

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  code: ErrorCode;
  detail: string;
  exitCode?: number;
}

export type ClaudeEvent =
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | ProgressEvent
  | DoneEvent
  | ErrorEvent;
