/**
 * Schema types for JSON Schema generation.
 * This file re-exports types for use with ts-json-schema-generator.
 * The generated schema is the single source of truth for wire protocol contracts.
 *
 * Only wire protocol event types are exported here. Process configuration (ProcessOptions)
 * and session management (Session) are internal implementation details and should not
 * appear in the wire protocol schema.
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

/**
 * Wire protocol version literal for schema validation.
 */
export type WireProtocolVersion = 1;
