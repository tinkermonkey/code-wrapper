// Process
export { CliProcess } from './process/CliProcess.js';
export type { CliBackend, ProcessOptions } from './process/types.js';

// Events
export { parseCliLine } from './events/EventParser.js';
export type {
  ClaudeEvent,
  ClaudeEventType,
  BaseEvent,
  TextEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  ProgressEvent,
  ReadyEvent,
  RetryEvent,
  DoneEvent,
  ErrorEvent,
  ErrorCode,
  RawEvent,
} from './events/types.js';

// Sessions
export { SessionManager } from './sessions/SessionManager.js';
export { createSessionStore } from './sessions/SessionStore.js';
export type { SessionManagerOptions } from './sessions/SessionManager.js';
export type { ISessionStore } from './sessions/SessionStore.js';
export type { Session } from './sessions/types.js';
