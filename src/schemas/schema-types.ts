/**
 * Schema types for JSON Schema generation.
 * This file re-exports types for use with ts-json-schema-generator.
 * The generated schema is the single source of truth for wire protocol contracts.
 */

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
} from '../events/types.js';

export type { CliBackend, ProcessOptions } from '../process/types.js';
export type { Session } from '../sessions/types.js';

/**
 * Wire protocol version literal for schema validation.
 */
export type WireProtocolVersion = 1;
