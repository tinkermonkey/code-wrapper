export type ClaudeEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'progress'
  | 'done'
  | 'error';

interface BaseEvent {
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
  /** First 200 chars of JSON-stringified input */
  inputSummary: string;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolUseId: string;
  isError: boolean;
  /** First 500 chars of combined text output */
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
  usage?: { inputTokens: number; outputTokens: number };
}

export type ErrorCode =
  | 'idle_timeout'
  | 'max_timeout'
  | 'nonzero_exit'
  | 'rate_limit'
  | 'spawn_error'
  | 'stale_session'
  | 'parse_error';

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
