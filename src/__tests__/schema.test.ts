import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  TextEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  ProgressEvent,
  ReadyEvent,
  RetryEvent,
  DoneEvent,
  ErrorEvent,
  RawEvent,
} from '../events/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '../../schemas/claude-event.v1.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv({ strictSchema: false });
const validate = ajv.compile(schema);

describe('JSON Schema validation', () => {
  describe('schema validity', () => {
    it('schema is valid JSON Schema draft-07', () => {
      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema.oneOf).toBeDefined();
      expect(schema.definitions).toBeDefined();
    });

    it('schema contains exactly 10 top-level event types in oneOf', () => {
      expect(schema.oneOf).toHaveLength(10);
      const types = schema.oneOf.map((ref: { $ref: string }) => ref.$ref.split('/').pop());
      expect(types).toEqual([
        'TextEvent',
        'ThinkingEvent',
        'ToolUseEvent',
        'ToolResultEvent',
        'ProgressEvent',
        'ReadyEvent',
        'RetryEvent',
        'DoneEvent',
        'ErrorEvent',
        'RawEvent',
      ]);
    });

    it('definitions contain only contract types (no leaked internals)', () => {
      const defNames = Object.keys(schema.definitions);
      const expectedTypes = [
        'BaseEvent',
        'ClaudeEventType',
        'CliBackend',
        'DoneEvent',
        'ErrorCode',
        'ErrorEvent',
        'ProcessOptions',
        'ProgressEvent',
        'RawEvent',
        'ReadyEvent',
        'RetryEvent',
        'Session',
        'TextEvent',
        'ThinkingEvent',
        'ToolResultEvent',
        'ToolUseEvent',
        'WireProtocolVersion',
      ];
      expect(new Set(defNames)).toEqual(new Set(expectedTypes));
    });
  });

  describe('event validation', () => {
    const baseEvent = { seq: 0, timestamp: Date.now(), type: 'text' };

    it('TextEvent validates against schema', () => {
      const event: TextEvent = { ...baseEvent, type: 'text', text: 'hello' } as TextEvent;
      expect(validate(event)).toBe(true);
    });

    it('ThinkingEvent validates against schema', () => {
      const event: ThinkingEvent = { ...baseEvent, type: 'thinking', thinking: 'wondering...' } as ThinkingEvent;
      expect(validate(event)).toBe(true);
    });

    it('ToolUseEvent validates against schema', () => {
      const event: ToolUseEvent = {
        ...baseEvent,
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/test' },
      } as ToolUseEvent;
      expect(validate(event)).toBe(true);
    });

    it('ToolResultEvent validates against schema', () => {
      const event: ToolResultEvent = {
        ...baseEvent,
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        output: 'file content',
      } as ToolResultEvent;
      expect(validate(event)).toBe(true);
    });

    it('ProgressEvent validates against schema', () => {
      const event: ProgressEvent = {
        ...baseEvent,
        type: 'progress',
        elapsed: 0.5,
      } as ProgressEvent;
      expect(validate(event)).toBe(true);
    });

    it('ReadyEvent validates against schema', () => {
      const event: ReadyEvent = {
        ...baseEvent,
        type: 'ready',
        sessionId: 'sess-1',
        model: 'claude-opus-4-1',
        tools: ['Read', 'Write'],
      } as ReadyEvent;
      expect(validate(event)).toBe(true);
    });

    it('RetryEvent validates against schema', () => {
      const event: RetryEvent = {
        ...baseEvent,
        type: 'retry',
        attempt: 2,
        delayMs: 1000,
        error: 'timeout',
      } as RetryEvent;
      expect(validate(event)).toBe(true);
    });

    it('DoneEvent validates against schema', () => {
      const event: DoneEvent = {
        ...baseEvent,
        type: 'done',
        sessionId: 'sess-1',
        exitCode: 0,
      } as DoneEvent;
      expect(validate(event)).toBe(true);
    });

    it('ErrorEvent validates against schema', () => {
      const event: ErrorEvent = {
        ...baseEvent,
        type: 'error',
        code: 'idle_timeout',
        detail: 'Request timed out',
      } as ErrorEvent;
      expect(validate(event)).toBe(true);
    });

    it('RawEvent validates against schema', () => {
      const event: RawEvent = {
        ...baseEvent,
        type: 'raw',
        rawType: 'unknown',
        data: { key: 'value' },
      } as RawEvent;
      expect(validate(event)).toBe(true);
    });
  });

  describe('event rejection', () => {
    it('rejects event with missing required type field', () => {
      const invalid = { seq: 0, timestamp: Date.now(), text: 'hello' };
      expect(validate(invalid)).toBe(false);
    });

    it('rejects event with missing required seq field', () => {
      const invalid = { type: 'text', timestamp: Date.now(), text: 'hello' };
      expect(validate(invalid)).toBe(false);
    });

    it('rejects event with invalid type value', () => {
      const invalid = { seq: 0, timestamp: Date.now(), type: 'invalid_type' };
      expect(validate(invalid)).toBe(false);
    });

    it('rejects TextEvent without required text field', () => {
      const invalid = { seq: 0, timestamp: Date.now(), type: 'text' };
      expect(validate(invalid)).toBe(false);
    });

    it('rejects ErrorEvent without required code field', () => {
      const invalid = { seq: 0, timestamp: Date.now(), type: 'error' };
      expect(validate(invalid)).toBe(false);
    });
  });
});
