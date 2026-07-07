import { describe, it, expect } from 'vitest';
import { parseCliLine, createCopilotAcpParser } from '../events/EventParser.js';
import type {
  ReadyEvent,
  RetryEvent,
  TextEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  DoneEvent,
  ErrorEvent,
  RawEvent,
} from '../events/types.js';

// Helpers
const line = (obj: unknown) => JSON.stringify(obj);

describe('parseCliLine', () => {
  // ------------------------------------------------------------------ system
  describe('system/init', () => {
    it('full init → ReadyEvent with sessionId, model, tools', () => {
      const [ev] = parseCliLine(
        line({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6', tools: [{ name: 'Read' }, { name: 'Write' }] }),
        0,
      ) as [ReadyEvent];
      expect(ev).toMatchObject({ type: 'ready', seq: 0, sessionId: 'sess-1', model: 'claude-sonnet-4-6', tools: ['Read', 'Write'] });
    });

    it('partial init (no model, no tools) → ReadyEvent without optional fields', () => {
      const [ev] = parseCliLine(
        line({ type: 'system', subtype: 'init', session_id: 'sess-2' }),
        5,
      ) as [ReadyEvent];
      expect(ev.type).toBe('ready');
      expect(ev.seq).toBe(5);
      expect(ev.sessionId).toBe('sess-2');
      expect(ev.model).toBeUndefined();
      expect(ev.tools).toBeUndefined();
    });

    it('tools with empty names are filtered out', () => {
      const [ev] = parseCliLine(
        line({ type: 'system', subtype: 'init', session_id: 's', tools: [{ name: 'Read' }, {}, { name: '' }] }),
        0,
      ) as [ReadyEvent];
      expect(ev.tools).toEqual(['Read']);
    });

    it('empty tools array remains empty', () => {
      const [ev] = parseCliLine(
        line({ type: 'system', subtype: 'init', session_id: 's', tools: [] }),
        0,
      ) as [ReadyEvent];
      expect(ev.tools).toEqual([]);
    });
  });

  describe('system/api_retry', () => {
    it('all fields → RetryEvent', () => {
      const [ev] = parseCliLine(
        line({ type: 'system', subtype: 'api_retry', attempt: 2, delay_ms: 1500, error: 'Connection reset' }),
        3,
      ) as [RetryEvent];
      expect(ev).toMatchObject({ type: 'retry', seq: 3, attempt: 2, delayMs: 1500, error: 'Connection reset' });
    });

    it('minimal (no optional fields) → RetryEvent with attempt=1', () => {
      const [ev] = parseCliLine(
        line({ type: 'system', subtype: 'api_retry' }),
        0,
      ) as [RetryEvent];
      expect(ev.type).toBe('retry');
      expect(ev.attempt).toBe(1);
      expect(ev.delayMs).toBeUndefined();
      expect(ev.error).toBeUndefined();
    });
  });

  it('system with unknown subtype → RawEvent with rawSubtype', () => {
    const [ev] = parseCliLine(
      line({ type: 'system', subtype: 'future_hook', payload: 42 }),
      0,
    ) as [RawEvent];
    expect(ev.type).toBe('raw');
    expect(ev.rawType).toBe('system');
    expect(ev.rawSubtype).toBe('future_hook');
  });

  // --------------------------------------------------------------- assistant
  describe('assistant', () => {
    it('text block → TextEvent', () => {
      const [ev] = parseCliLine(
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
        0,
      ) as [TextEvent];
      expect(ev).toMatchObject({ type: 'text', text: 'Hello' });
    });

    it('thinking block → ThinkingEvent', () => {
      const [ev] = parseCliLine(
        line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Reasoning...' }] } }),
        0,
      ) as [ThinkingEvent];
      expect(ev).toMatchObject({ type: 'thinking', thinking: 'Reasoning...' });
    });

    it('tool_use block → ToolUseEvent', () => {
      const [ev] = parseCliLine(
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { cmd: 'ls' } }] } }),
        0,
      ) as [ToolUseEvent];
      expect(ev).toMatchObject({ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { cmd: 'ls' } });
    });

    it('unknown block type → RawEvent with rawSubtype set to block type', () => {
      const [ev] = parseCliLine(
        line({ type: 'assistant', message: { content: [{ type: 'server_tool_use', id: 'x' }] } }),
        0,
      ) as [RawEvent];
      expect(ev.type).toBe('raw');
      expect(ev.rawType).toBe('assistant');
      expect(ev.rawSubtype).toBe('server_tool_use');
    });

    it('empty content array → single RawEvent', () => {
      const evs = parseCliLine(
        line({ type: 'assistant', message: { content: [] } }),
        0,
      );
      expect(evs).toHaveLength(1);
      expect(evs[0].type).toBe('raw');
    });

    it('mixed blocks → one event per block in order', () => {
      const evs = parseCliLine(
        line({ type: 'assistant', message: { content: [
          { type: 'thinking', thinking: 'A' },
          { type: 'text', text: 'B' },
          { type: 'tool_use', id: 'x', name: 'Read', input: {} },
        ] } }),
        10,
      );
      expect(evs).toHaveLength(3);
      expect(evs.map(e => [e.type, e.seq])).toEqual([['thinking', 10], ['text', 11], ['tool_use', 12]]);
    });

    it('text block with no text property → RawEvent (falsy guard)', () => {
      const [ev] = parseCliLine(
        line({ type: 'assistant', message: { content: [{ type: 'text' }] } }),
        0,
      );
      expect(ev.type).toBe('raw');
    });

    it('tool_use block with missing id → RawEvent (falsy guard)', () => {
      const [ev] = parseCliLine(
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
        0,
      );
      expect(ev.type).toBe('raw');
    });
  });

  // --------------------------------------------------------------- tool_result
  it('tool_result → ToolResultEvent with joined output', () => {
    const [ev] = parseCliLine(
      line({ type: 'tool_result', tool_use_id: 'tu-2', content: [{ type: 'text', text: 'file content' }], is_error: false }),
      0,
    ) as [ToolResultEvent];
    expect(ev).toMatchObject({ type: 'tool_result', toolUseId: 'tu-2', isError: false, output: 'file content' });
  });

  it('tool_result with multiple text blocks → concatenated output', () => {
    const [ev] = parseCliLine(
      line({ type: 'tool_result', tool_use_id: 'tu-3', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], is_error: true }),
      0,
    ) as [ToolResultEvent];
    expect(ev.isError).toBe(true);
    expect(ev.output).toBe('AB');
  });

  // --------------------------------------------------------------- user
  it('user event → single RawEvent (no ToolResultEvent extraction)', () => {
    const evs = parseCliLine(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [] }] } }),
      0,
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'raw', rawType: 'user' });
  });

  // --------------------------------------------------------------- result
  describe('result', () => {
    it('full usage including cache fields → DoneEvent', () => {
      const [ev] = parseCliLine(
        line({ type: 'result', session_id: 'sess-done', usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } }),
        0,
      ) as [DoneEvent];
      expect(ev).toMatchObject({
        type: 'done',
        sessionId: 'sess-done',
        usage: { inputTokens: 200, outputTokens: 80, cacheReadInputTokens: 50, cacheCreationInputTokens: 20 },
      });
    });

    it('partial usage (no cache fields) → cache props absent', () => {
      const [ev] = parseCliLine(
        line({ type: 'result', session_id: 's', usage: { input_tokens: 10, output_tokens: 5 } }),
        0,
      ) as [DoneEvent];
      expect(ev.usage?.cacheReadInputTokens).toBeUndefined();
      expect(ev.usage?.cacheCreationInputTokens).toBeUndefined();
    });

    it('no usage field → DoneEvent with usage: undefined', () => {
      const [ev] = parseCliLine(
        line({ type: 'result', session_id: 's' }),
        0,
      ) as [DoneEvent];
      expect(ev.type).toBe('done');
      expect(ev.usage).toBeUndefined();
    });
  });

  // --------------------------------------------------------------- rate_limit_event
  describe('rate_limit_event', () => {
    it('with reset_at → rate_limit ErrorEvent containing reset time', () => {
      const [ev] = parseCliLine(
        line({ type: 'rate_limit_event', reset_at: '2026-01-01T00:00:00Z' }),
        0,
      ) as [ErrorEvent];
      expect(ev.code).toBe('rate_limit');
      expect(ev.detail).toContain('2026-01-01T00:00:00Z');
    });

    it('with retry_after → rate_limit ErrorEvent containing retry seconds', () => {
      const [ev] = parseCliLine(
        line({ type: 'rate_limit_event', retry_after: 30 }),
        0,
      ) as [ErrorEvent];
      expect(ev.code).toBe('rate_limit');
      expect(ev.detail).toContain('30');
    });

    it('bare (no fields) → rate_limit ErrorEvent with non-empty detail', () => {
      const [ev] = parseCliLine(line({ type: 'rate_limit_event' }), 0) as [ErrorEvent];
      expect(ev.code).toBe('rate_limit');
      expect(ev.detail.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------- error types
  it.each(['error', 'error_detail', 'error_event'])('%s → ErrorEvent { cli_error }', (rawType) => {
    const [ev] = parseCliLine(
      line({ type: rawType, message: 'Something went wrong' }),
      0,
    ) as [ErrorEvent];
    expect(ev.type).toBe('error');
    expect(ev.code).toBe('cli_error');
    expect(ev.detail).toBe('Something went wrong');
  });

  // --------------------------------------------------------------- unknown type
  it('unknown type → RawEvent preserving rawType and data', () => {
    const [ev] = parseCliLine(
      line({ type: 'future_event', foo: 'bar' }),
      0,
    ) as [RawEvent];
    expect(ev.type).toBe('raw');
    expect(ev.rawType).toBe('future_event');
    expect((ev.data as Record<string, unknown>)['foo']).toBe('bar');
  });

  // --------------------------------------------------------------- malformed JSON
  it('line starting with { that is not valid JSON → parse_error ErrorEvent', () => {
    const [ev] = parseCliLine('{bad json', 0) as [ErrorEvent];
    expect(ev.type).toBe('error');
    expect(ev.code).toBe('parse_error');
    expect(ev.detail).toContain('{bad json');
  });

  // --------------------------------------------------------------- plaintext
  it('plaintext not starting with { → TextEvent with trailing newline', () => {
    const [ev] = parseCliLine('Starting Claude...', 0) as [TextEvent];
    expect(ev.type).toBe('text');
    expect(ev.text).toBe('Starting Claude...\n');
  });

  // --------------------------------------------------------------- seq
  it('nextSeq is used as the first seq value', () => {
    const [ev] = parseCliLine(line({ type: 'system', subtype: 'init', session_id: 's' }), 42);
    expect(ev.seq).toBe(42);
  });

  it('seq increments across multi-event parse', () => {
    const evs = parseCliLine(
      line({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'A' },
        { type: 'text', text: 'B' },
        { type: 'tool_use', id: 'x', name: 'Read', input: {} },
      ] } }),
      7,
    );
    expect(evs.map(e => e.seq)).toEqual([7, 8, 9]);
  });
});

describe('createCopilotAcpParser session/new handshake', () => {
  const initAck = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, capabilities: {} } });
  const sessionNewAck = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'new-session-abc' } });

  it('initialize ack (first response) does NOT emit ReadyEvent', () => {
    const parse = createCopilotAcpParser();
    const events = parse(initAck, 0);
    expect(events.every(e => e.type !== 'ready')).toBe(true);
  });

  it('session/new ack (result.sessionId) emits ReadyEvent — same for new and resumed sessions', () => {
    const parse = createCopilotAcpParser();
    parse(initAck, 0);
    const events = parse(sessionNewAck, 1) as [ReadyEvent];
    const ready = events.find(e => e.type === 'ready') as ReadyEvent | undefined;
    expect(ready).toBeDefined();
    expect(ready!.sessionId).toBe('new-session-abc');
  });

  it('ReadyEvent is not emitted twice', () => {
    const parse = createCopilotAcpParser();
    parse(initAck, 0);
    const first = parse(sessionNewAck, 1);
    const second = parse(sessionNewAck, 10);
    expect(first.filter(e => e.type === 'ready')).toHaveLength(1);
    expect(second.filter(e => e.type === 'ready')).toHaveLength(0);
  });

  it('session/prompt ack with stopReason (after session/new) emits DoneEvent for the session/new uuid', () => {
    const parse = createCopilotAcpParser();
    parse(initAck, 0);
    parse(sessionNewAck, 1);
    const events = parse(
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }),
      2,
    ) as [DoneEvent];
    const done = events.find(e => e.type === 'done') as DoneEvent | undefined;
    expect(done).toBeDefined();
    expect(done!.sessionId).toBe('new-session-abc');
  });
});

describe('createCopilotAcpParser', () => {
  it('empty line returns []', () => {
    const parse = createCopilotAcpParser();
    expect(parse('', 0)).toEqual([]);
  });

  it('whitespace-only line returns []', () => {
    const parse = createCopilotAcpParser();
    expect(parse('   \t  ', 0)).toEqual([]);
  });

  it('line starting with { that is not valid JSON → parse_error ErrorEvent', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse('{bad json', 0) as [ErrorEvent];
    expect(ev.type).toBe('error');
    expect(ev.code).toBe('parse_error');
    expect(ev.detail).toContain('{bad json');
  });

  it('plaintext line (no { prefix) → parse_error ErrorEvent', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse('Starting copilot...', 0) as [ErrorEvent];
    expect(ev.type).toBe('error');
    expect(ev.code).toBe('parse_error');
  });

  it('seq parameter is respected on parse_error', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse('{truncated', 5);
    expect(ev.seq).toBe(5);
  });

  it('seq parameter is respected on TextEvent', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse('plain text', 3);
    expect(ev.seq).toBe(3);
  });
});
