// Process
export { CliProcess } from './process/CliProcess.js';
export type { CliBackend, ProcessOptions } from './process/types.js';

// Events
export { parseCliLine } from './events/EventParser.js';
export type {
  ClaudeEvent,
  ClaudeEventType,
  TextEvent,
  ToolUseEvent,
  ToolResultEvent,
  ProgressEvent,
  DoneEvent,
  ErrorEvent,
  ErrorCode,
} from './events/types.js';

// Sessions
export { SessionManager } from './sessions/SessionManager.js';
export { createSessionStore } from './sessions/SessionStore.js';
export type { SessionManagerOptions } from './sessions/SessionManager.js';
export type { ISessionStore } from './sessions/SessionStore.js';
export type { Session } from './sessions/types.js';
