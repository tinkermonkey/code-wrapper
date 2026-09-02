import { describe, it, expect } from 'vitest';
import { parseCliLine, createCopilotAcpParser, createGeminiStreamParser, createCursorStreamParser } from '../events/EventParser.js';
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

    it('result/is_error/duration_ms/total_cost_usd/num_turns → DoneEvent carries all of them', () => {
      const [ev] = parseCliLine(
        line({
          type: 'result',
          session_id: 'sess-done',
          result: 'The final answer is 42.',
          is_error: false,
          duration_ms: 4321,
          total_cost_usd: 0.0512,
          num_turns: 3,
        }),
        0,
      ) as [DoneEvent];
      expect(ev).toMatchObject({
        type: 'done',
        sessionId: 'sess-done',
        resultText: 'The final answer is 42.',
        isError: false,
        durationMs: 4321,
        totalCostUsd: 0.0512,
        numTurns: 3,
      });
    });

    it('is_error: true → DoneEvent.isError is true', () => {
      const [ev] = parseCliLine(
        line({ type: 'result', session_id: 's', result: 'Failed partway through.', is_error: true }),
        0,
      ) as [DoneEvent];
      expect(ev.isError).toBe(true);
      expect(ev.resultText).toBe('Failed partway through.');
    });

    it('no result/is_error/duration_ms/total_cost_usd/num_turns fields → all absent on DoneEvent', () => {
      const [ev] = parseCliLine(
        line({ type: 'result', session_id: 's' }),
        0,
      ) as [DoneEvent];
      expect(ev.resultText).toBeUndefined();
      expect(ev.isError).toBeUndefined();
      expect(ev.durationMs).toBeUndefined();
      expect(ev.totalCostUsd).toBeUndefined();
      expect(ev.numTurns).toBeUndefined();
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
    expect(done!.stopReason).toBe('end_turn');
  });

  it('session/prompt ack stopReason value is passed through verbatim (e.g. max_tokens)', () => {
    const parse = createCopilotAcpParser();
    parse(initAck, 0);
    parse(sessionNewAck, 1);
    const events = parse(
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'max_tokens' } }),
      2,
    ) as [DoneEvent];
    const done = events.find(e => e.type === 'done') as DoneEvent | undefined;
    expect(done!.stopReason).toBe('max_tokens');
  });

  it('session.idle (fake/legacy protocol) DoneEvent has no stopReason', () => {
    const parse = createCopilotAcpParser();
    parse(initAck, 0);
    parse(sessionNewAck, 1);
    const events = parse(
      JSON.stringify({ jsonrpc: '2.0', method: 'session.idle', params: {} }),
      2,
    ) as [DoneEvent];
    const done = events.find(e => e.type === 'done') as DoneEvent | undefined;
    expect(done).toBeDefined();
    expect(done!.stopReason).toBeUndefined();
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

  it('session/update tool_call → ToolUseEvent', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_abc123',
          title: 'Creating /tmp/e2e-sentinel.txt',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: '/tmp/e2e-sentinel.txt', file_text: 'hello' },
        },
      },
    }), 0) as [ToolUseEvent];
    expect(ev.type).toBe('tool_use');
    expect(ev.id).toBe('call_abc123');
    expect(ev.name).toBe('edit');
    expect(ev.input).toEqual({ path: '/tmp/e2e-sentinel.txt', file_text: 'hello' });
  });

  it('session/update tool_call without a kind falls back to title', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_xyz',
          title: 'Run a shell command',
          rawInput: { command: 'ls' },
        },
      },
    }), 0) as [ToolUseEvent];
    expect(ev.name).toBe('Run a shell command');
  });

  it('session/update tool_call_update with terminal status "completed" → ToolResultEvent', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_abc123',
          status: 'completed',
          rawOutput: { content: 'Created file /tmp/e2e-sentinel.txt with 5 characters' },
        },
      },
    }), 0) as [ToolResultEvent];
    expect(ev.type).toBe('tool_result');
    expect(ev.toolUseId).toBe('call_abc123');
    expect(ev.isError).toBe(false);
    expect(ev.output).toBe('Created file /tmp/e2e-sentinel.txt with 5 characters');
  });

  it('session/update tool_call_update with terminal status "failed" → ToolResultEvent { isError: true }', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_abc123',
          status: 'failed',
          rawOutput: { content: 'Permission denied' },
        },
      },
    }), 0) as [ToolResultEvent];
    expect(ev.isError).toBe(true);
  });

  it('session/update tool_call_update with non-terminal status → []', () => {
    const parse = createCopilotAcpParser();
    const result = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_abc123', status: 'in_progress' },
      },
    }), 0);
    expect(result).toEqual([]);
  });

  it('session/update tool_call with missing toolCallId → RawEvent (zero-loss)', () => {
    const parse = createCopilotAcpParser();
    const msg = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call', title: 'Creating a file', kind: 'edit', rawInput: {} },
      },
    };
    const [ev] = parse(line(msg), 0) as [RawEvent];
    expect(ev.type).toBe('raw');
    expect(ev.rawType).toBe('acp/tool_call_missing_id');
    expect(ev.data).toEqual(msg);
  });

  it('session/update tool_call_update terminal status with missing toolCallId → RawEvent (zero-loss)', () => {
    const parse = createCopilotAcpParser();
    const msg = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: { content: 'done' } },
      },
    };
    const [ev] = parse(line(msg), 0) as [RawEvent];
    expect(ev.type).toBe('raw');
    expect(ev.rawType).toBe('acp/tool_call_update_missing_id');
    expect(ev.data).toEqual(msg);
  });

  it('session/update tool_call kind: 0 (falsy but non-nullish) is coerced to string, not skipped by ??', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call', toolCallId: 'call_falsy', kind: 0, title: 'fallback title' },
      },
    }), 0) as [ToolUseEvent];
    expect(ev.name).toBe('0');
  });

  it('session/update tool_call_update rawOutput.content non-string falls back to JSON.stringify', () => {
    const parse = createCopilotAcpParser();
    const rawOutput = { exitCode: 1, stderr: 'boom' };
    const [ev] = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_abc123', status: 'failed', rawOutput },
      },
    }), 0) as [ToolResultEvent];
    expect(ev.output).toBe(JSON.stringify(rawOutput));
  });

  it('session/update tool_call_update with no rawOutput falls back to JSON.stringify({})', () => {
    const parse = createCopilotAcpParser();
    const [ev] = parse(line({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_abc123', status: 'completed' },
      },
    }), 0) as [ToolResultEvent];
    expect(ev.output).toBe('{}');
  });
});

describe('createGeminiStreamParser', () => {
  describe('init event', () => {
    it('init with full data → ReadyEvent with sessionId, model, tools', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'init',
        conversation_id: 'conv-123',
        init: { model: 'claude-3-5-sonnet', tools: [{ name: 'Read' }, { name: 'Write' }] },
      }), 0) as [ReadyEvent];
      expect(ev).toMatchObject({
        type: 'ready', seq: 0, sessionId: 'conv-123',
        model: 'claude-3-5-sonnet', tools: ['Read', 'Write'],
      });
    });

    it('init with minimal data → ReadyEvent with only sessionId', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'init',
        conversation_id: 'conv-456',
        init: {},
      }), 5) as [ReadyEvent];
      expect(ev.type).toBe('ready');
      expect(ev.seq).toBe(5);
      expect(ev.sessionId).toBe('conv-456');
      expect(ev.model).toBeUndefined();
      expect(ev.tools).toBeUndefined();
    });

    it('init tools with empty names are filtered out', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'init',
        conversation_id: 'conv-789',
        init: { tools: [{ name: 'Read' }, {}, { name: '' }] },
      }), 0) as [ReadyEvent];
      expect(ev.tools).toEqual(['Read']);
    });

    it('conversationId persists for subsequent events', () => {
      const parse = createGeminiStreamParser();
      parse(line({
        event: 'init',
        conversation_id: 'persisted-conv',
        init: {},
      }), 0);
      const [resultEv] = parse(line({
        event: 'result',
        result: { status: 'success' },
      }), 1) as [DoneEvent];
      expect(resultEv.sessionId).toBe('persisted-conv');
    });
  });

  describe('step_update event', () => {
    describe('agent_response', () => {
      it('agent_response with text_delta → TextEvent', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: { step_type: 'agent_response', text_delta: 'Hello world' },
        }), 0) as [TextEvent];
        expect(ev).toMatchObject({ type: 'text', text: 'Hello world' });
      });

      it('agent_response with empty text_delta → TextEvent with empty text', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: { step_type: 'agent_response', text_delta: '' },
        }), 0) as [TextEvent];
        expect(ev).toMatchObject({ type: 'text', text: '' });
      });

      it('agent_response without text_delta → RawEvent (metadata-only)', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: { step_type: 'agent_response' },
        }), 0);
        expect(ev).toMatchObject({
          type: 'raw',
          rawType: 'gemini/step_update',
          rawSubtype: 'agent_response',
        });
      });
    });

    describe('tool steps', () => {
      it('tool ACTIVE state → ToolUseEvent', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            state: 'ACTIVE',
            tool_info: { tool_use_id: 'tool-1', name: 'Bash', parameters: { cmd: 'ls' } },
          },
        }), 0) as [ToolUseEvent];
        expect(ev).toMatchObject({
          type: 'tool_use', id: 'tool-1', name: 'Bash', input: { cmd: 'ls' },
        });
      });

      it('tool DONE state → ToolResultEvent', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            state: 'DONE',
            tool_info: { tool_use_id: 'tool-2', output: 'result text' },
          },
        }), 0) as [ToolResultEvent];
        expect(ev).toMatchObject({
          type: 'tool_result', toolUseId: 'tool-2', isError: false, output: 'result text',
        });
      });

      it('tool DONE with error → ToolResultEvent with isError=true', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            state: 'DONE',
            tool_info: { tool_use_id: 'tool-3', error: 'Tool failed' },
          },
        }), 0) as [ToolResultEvent];
        expect(ev.isError).toBe(true);
        expect(ev.output).toBe('Tool failed');
      });

      it('tool DONE with both output and error → error takes precedence', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            state: 'DONE',
            tool_info: { tool_use_id: 'tool-4', output: 'output', error: 'error' },
          },
        }), 0) as [ToolResultEvent];
        expect(ev.isError).toBe(true);
        expect(ev.output).toBe('error');
      });

      it('tool without tool_use_id → RawEvent', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            state: 'ACTIVE',
            tool_info: { name: 'Bash' },
          },
        }), 0) as [RawEvent];
        expect(ev.type).toBe('raw');
        expect(ev.rawType).toBe('gemini/step_update');
      });

      it('tool with unknown state → RawEvent', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            state: 'PENDING',
            tool_info: { tool_use_id: 'x' },
          },
        }), 0) as [RawEvent];
        expect(ev.type).toBe('raw');
      });
    });

    describe('other step_types', () => {
      it('unknown step_type → RawEvent', () => {
        const parse = createGeminiStreamParser();
        const [ev] = parse(line({
          event: 'step_update',
          step_update: { step_type: 'future_step' },
        }), 0) as [RawEvent];
        expect(ev.type).toBe('raw');
        expect(ev.rawType).toBe('gemini/step_update');
        expect(ev.rawSubtype).toBe('future_step');
      });
    });
  });

  describe('result event', () => {
    it('result with full data → DoneEvent', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'result',
        result: {
          conversation_id: 'conv-done',
          status: 'success',
          duration_seconds: 5.5,
          num_turns: 3,
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }), 0) as [DoneEvent];
      expect(ev).toMatchObject({
        type: 'done',
        sessionId: 'conv-done',
        durationMs: 5500,
        numTurns: 3,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      expect(ev.isError).toBeUndefined();
    });

    it('result with status=error → DoneEvent with isError=true', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'result',
        result: { conversation_id: 'conv-err', status: 'error' },
      }), 0) as [DoneEvent];
      expect(ev.isError).toBe(true);
    });

    it('result without conversation_id uses stored conversationId', () => {
      const parse = createGeminiStreamParser();
      parse(line({
        event: 'init',
        conversation_id: 'stored-conv',
        init: {},
      }), 0);
      const [ev] = parse(line({
        event: 'result',
        result: { status: 'success' },
      }), 1) as [DoneEvent];
      expect(ev.sessionId).toBe('stored-conv');
    });

    it('result with minimal data → DoneEvent with sessionId only', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'result',
        result: { conversation_id: 'minimal' },
      }), 0) as [DoneEvent];
      expect(ev.type).toBe('done');
      expect(ev.sessionId).toBe('minimal');
      expect(ev.usage).toBeUndefined();
      expect(ev.durationMs).toBeUndefined();
      expect(ev.numTurns).toBeUndefined();
      expect(ev.isError).toBeUndefined();
    });
  });

  describe('error event', () => {
    it('error with stale session message → ErrorEvent with code=stale_session', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'error',
        error: { message: 'conversation not found' },
      }), 0) as [ErrorEvent];
      expect(ev).toMatchObject({
        type: 'error', code: 'stale_session', detail: 'conversation not found',
      });
    });

    it('error with rate limit message → ErrorEvent with code=rate_limit', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'error',
        error: { message: 'rate limit exceeded' },
      }), 0) as [ErrorEvent];
      expect(ev.code).toBe('rate_limit');
    });

    it('error with quota exceeded message → ErrorEvent with code=rate_limit', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'error',
        error: { message: 'quota exceeded' },
      }), 0) as [ErrorEvent];
      expect(ev.code).toBe('rate_limit');
    });

    it('error with generic message → ErrorEvent with code=cli_error', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'error',
        error: { message: 'something went wrong' },
      }), 0) as [ErrorEvent];
      expect(ev.code).toBe('cli_error');
    });

    it('error with empty message → ErrorEvent with code=cli_error', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'error',
        error: {},
      }), 0) as [ErrorEvent];
      expect(ev.code).toBe('cli_error');
      expect(ev.detail).toBe('');
    });

    it('error regex is case-insensitive', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'error',
        error: { message: 'Conversation Not Found' },
      }), 0) as [ErrorEvent];
      expect(ev.code).toBe('stale_session');
    });

    it('error regex handles rate-limit with dash', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'error',
        error: { message: 'rate-limit hit' },
      }), 0) as [ErrorEvent];
      expect(ev.code).toBe('rate_limit');
    });
  });

  describe('unrecognized events', () => {
    it('unknown event value → RawEvent with rawType=gemini/<event>', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse(line({
        event: 'unknown_event',
        payload: { data: 42 },
      }), 0) as [RawEvent];
      expect(ev).toMatchObject({
        type: 'raw', rawType: 'gemini/unknown_event',
      });
      expect(ev.data).toEqual({ event: 'unknown_event', payload: { data: 42 } });
    });
  });

  describe('malformed JSON and plaintext', () => {
    it('malformed JSON line starting with { → ErrorEvent with code=parse_error', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse('{ invalid json', 0) as [ErrorEvent];
      expect(ev).toMatchObject({
        type: 'error', code: 'parse_error', detail: expect.stringContaining('Malformed JSON'),
      });
    });

    it('plaintext line (no leading {) → TextEvent', () => {
      const parse = createGeminiStreamParser();
      const [ev] = parse('startup message', 0) as [TextEvent];
      expect(ev).toMatchObject({ type: 'text', text: 'startup message\n' });
    });

    it('empty line → no events', () => {
      const parse = createGeminiStreamParser();
      const evs = parse('', 0);
      expect(evs).toHaveLength(0);
    });

    it('whitespace-only line → no events', () => {
      const parse = createGeminiStreamParser();
      const evs = parse('   ', 0);
      expect(evs).toHaveLength(0);
    });
  });

  describe('seq numbering', () => {
    it('preserves and increments seq across multiple events', () => {
      const parse = createGeminiStreamParser();
      const ev1s = parse(line({
        event: 'init', conversation_id: 'c1', init: {},
      }), 10);
      const ev2s = parse(line({
        event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hi' },
      }), 10 + ev1s.length);
      expect(ev1s[0].seq).toBe(10);
      expect(ev2s[0].seq).toBe(11);
    });
  });

  describe('timestamp', () => {
    it('each event has a timestamp', () => {
      const parse = createGeminiStreamParser();
      const before = Date.now();
      const [ev] = parse(line({ event: 'init', conversation_id: 'c', init: {} }), 0);
      const after = Date.now();
      expect(ev.timestamp).toBeGreaterThanOrEqual(before);
      expect(ev.timestamp).toBeLessThanOrEqual(after);
    });
  });
});

describe('createCursorStreamParser', () => {
  describe('system/init', () => {
    it('full init → ReadyEvent with sessionId and model', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'system', subtype: 'init', session_id: 'chat-123', model: 'gpt-4',
      }), 0) as [ReadyEvent];
      expect(ev).toMatchObject({ type: 'ready', seq: 0, sessionId: 'chat-123', model: 'gpt-4' });
    });

    it('partial init (no model) → ReadyEvent without model', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'system', subtype: 'init', session_id: 'chat-456',
      }), 5) as [ReadyEvent];
      expect(ev.type).toBe('ready');
      expect(ev.seq).toBe(5);
      expect(ev.sessionId).toBe('chat-456');
      expect(ev.model).toBeUndefined();
    });

    it('resets deduplication state on new session', () => {
      const parse = createCursorStreamParser();
      // First session init
      parse(line({ type: 'system', subtype: 'init', session_id: 'sess-1' }), 0);
      // Process an assistant event
      const evs1 = parse(line({
        type: 'assistant', text: 'hello', timestamp_ms: 100, model_call_id: 'call-1',
      }), 1) as [TextEvent];
      expect(evs1).toHaveLength(1);

      // New session init should reset deduplication state
      parse(line({ type: 'system', subtype: 'init', session_id: 'sess-2' }), 2);
      // The same timestamp/model_call_id in a new session should emit again
      const evs2 = parse(line({
        type: 'assistant', text: 'hello', timestamp_ms: 100, model_call_id: 'call-1',
      }), 3) as [TextEvent];
      expect(evs2).toHaveLength(1);
    });
  });

  describe('assistant (text output with deduplication)', () => {
    it('single assistant event → TextEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'assistant', text: 'Hello world', timestamp_ms: 100, model_call_id: 'call-1',
      }), 0) as [TextEvent];
      expect(ev).toMatchObject({ type: 'text', seq: 0, text: 'Hello world' });
    });

    it('empty text → no TextEvent', () => {
      const parse = createCursorStreamParser();
      const evs = parse(line({
        type: 'assistant', text: '', timestamp_ms: 100, model_call_id: 'call-1',
      }), 0);
      expect(evs).toHaveLength(0);
    });

    it('duplicate canonical event (same timestamp_ms and model_call_id) → skipped', () => {
      const parse = createCursorStreamParser();
      // First: canonical form with model_call_id
      const evs1 = parse(line({
        type: 'assistant', text: 'Hello', timestamp_ms: 100, model_call_id: 'call-1',
      }), 0) as [TextEvent];
      expect(evs1).toHaveLength(1);

      // Second: duplicate canonical event (same timestamp_ms and model_call_id)
      const evs2 = parse(line({
        type: 'assistant', text: 'Hello', timestamp_ms: 100, model_call_id: 'call-1',
      }), 1);
      expect(evs2).toHaveLength(0);
    });

    it('multiple assistant events with different timestamps → all emitted', () => {
      const parse = createCursorStreamParser();
      const evs1 = parse(line({
        type: 'assistant', text: 'First', timestamp_ms: 100, model_call_id: 'call-1',
      }), 0) as [TextEvent];
      expect(evs1).toHaveLength(1);

      const evs2 = parse(line({
        type: 'assistant', text: 'Second', timestamp_ms: 200, model_call_id: 'call-2',
      }), 1) as [TextEvent];
      expect(evs2).toHaveLength(1);

      expect(evs1[0].text).toBe('First');
      expect(evs2[0].text).toBe('Second');
    });

    it('partial events (no model_call_id) are always skipped', () => {
      const parse = createCursorStreamParser();
      // Partial form (no model_call_id) is skipped
      const evs1 = parse(line({
        type: 'assistant', text: 'Hello', timestamp_ms: 100,
      }), 0);
      expect(evs1).toHaveLength(0);

      // Canonical form (has model_call_id) is emitted
      const evs2 = parse(line({
        type: 'assistant', text: 'Hello', timestamp_ms: 100, model_call_id: 'call-1',
      }), 1) as [TextEvent];
      expect(evs2).toHaveLength(1);
      expect(evs2[0].text).toBe('Hello');
    });

    it('no ThinkingEvent is ever produced', () => {
      const parse = createCursorStreamParser();
      const evs = parse(line({
        type: 'assistant', text: 'response', thinking: 'internal reasoning',
      }), 0);
      expect(evs.some(e => e.type === 'thinking')).toBe(false);
    });
  });

  describe('tool_call/started', () => {
    it('bash tool → ToolUseEvent with name "bash"', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'started', tool_call_id: 'tc-1',
        bashToolCall: { input: { cmd: 'ls -la' } },
      }), 0) as [ToolUseEvent];
      expect(ev).toMatchObject({
        type: 'tool_use', seq: 0, id: 'tc-1', name: 'bash',
        input: { cmd: 'ls -la' },
      });
    });

    it('read tool → ToolUseEvent with name "read"', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'started', tool_call_id: 'tc-2',
        readToolCall: { input: { path: '/file.txt' } },
      }), 0) as [ToolUseEvent];
      expect(ev).toMatchObject({
        type: 'tool_use', seq: 0, id: 'tc-2', name: 'read',
        input: { path: '/file.txt' },
      });
    });

    it('write tool → ToolUseEvent with name "write"', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'started', tool_call_id: 'tc-3',
        writeToolCall: { input: { path: '/out.txt', content: 'data' } },
      }), 0) as [ToolUseEvent];
      expect(ev).toMatchObject({
        type: 'tool_use', seq: 0, id: 'tc-3', name: 'write',
        input: { path: '/out.txt', content: 'data' },
      });
    });

    it('missing tool_call_id → RawEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'started',
        bashToolCall: { input: { cmd: 'ls' } },
      }), 0) as [RawEvent];
      expect(ev.type).toBe('raw');
      expect(ev.rawType).toBe('tool_call');
      expect(ev.rawSubtype).toBe('started');
    });

    it('unknown tool type → ToolUseEvent with name "unknown"', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'started', tool_call_id: 'tc-4',
        futureToolCall: { input: { data: 'test' } },
      }), 0) as [ToolUseEvent];
      expect(ev).toMatchObject({
        type: 'tool_use', id: 'tc-4', name: 'unknown',
      });
    });
  });

  describe('tool_call/completed', () => {
    it('bash tool with string result → ToolResultEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'completed', tool_call_id: 'tc-1',
        bashToolCall: { result: 'file1.txt\nfile2.txt' },
      }), 0) as [ToolResultEvent];
      expect(ev).toMatchObject({
        type: 'tool_result', seq: 0, toolUseId: 'tc-1',
        output: 'file1.txt\nfile2.txt', isError: false,
      });
    });

    it('read tool with string result → ToolResultEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'completed', tool_call_id: 'tc-2',
        readToolCall: { result: 'file contents' },
      }), 0) as [ToolResultEvent];
      expect(ev).toMatchObject({
        type: 'tool_result', toolUseId: 'tc-2',
        output: 'file contents', isError: false,
      });
    });

    it('write tool with object result → ToolResultEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'completed', tool_call_id: 'tc-3',
        writeToolCall: { result: { output: 'File written' } },
      }), 0) as [ToolResultEvent];
      expect(ev).toMatchObject({
        type: 'tool_result', toolUseId: 'tc-3',
        output: 'File written', isError: false,
      });
    });

    it('tool result with error → ToolResultEvent with isError=true', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'completed', tool_call_id: 'tc-4',
        bashToolCall: { result: { error: 'Command failed' } },
      }), 0) as [ToolResultEvent];
      expect(ev).toMatchObject({
        type: 'tool_result', toolUseId: 'tc-4',
        output: 'Command failed', isError: true,
      });
    });

    it('missing tool_call_id → RawEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'tool_call', subtype: 'completed',
        bashToolCall: { result: 'output' },
      }), 0) as [RawEvent];
      expect(ev.type).toBe('raw');
      expect(ev.rawType).toBe('tool_call');
      expect(ev.rawSubtype).toBe('completed');
    });
  });

  describe('result/success', () => {
    it('result event → DoneEvent with sessionId and durationMs', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'result', subtype: 'success', session_id: 'chat-999',
        duration_ms: 5000, result: 'Final answer',
      }), 0) as [DoneEvent];
      expect(ev).toMatchObject({
        type: 'done', seq: 0, sessionId: 'chat-999',
        durationMs: 5000, resultText: 'Final answer',
      });
    });

    it('result event without duration_ms → DoneEvent without durationMs', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'result', subtype: 'success', session_id: 'chat-888',
      }), 0) as [DoneEvent];
      expect(ev.type).toBe('done');
      expect(ev.sessionId).toBe('chat-888');
      expect(ev.durationMs).toBeUndefined();
      expect(ev.resultText).toBeUndefined();
    });

    it('result event without resultText → DoneEvent without resultText', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'result', subtype: 'success', session_id: 'chat-777',
        duration_ms: 3000,
      }), 0) as [DoneEvent];
      expect(ev.type).toBe('done');
      expect(ev.durationMs).toBe(3000);
      expect(ev.resultText).toBeUndefined();
    });
  });

  describe('unknown events', () => {
    it('unknown event type → RawEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'future_event', subtype: 'unknown', data: { foo: 'bar' },
      }), 0) as [RawEvent];
      expect(ev.type).toBe('raw');
      expect(ev.rawType).toBe('future_event');
      expect(ev.rawSubtype).toBe('unknown');
      expect(ev.data).toEqual({ type: 'future_event', subtype: 'unknown', data: { foo: 'bar' } });
    });

    it('known type with unknown subtype → RawEvent with rawSubtype', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse(line({
        type: 'system', subtype: 'future_subtype', payload: 42,
      }), 0) as [RawEvent];
      expect(ev.type).toBe('raw');
      expect(ev.rawType).toBe('system');
      expect(ev.rawSubtype).toBe('future_subtype');
    });
  });

  describe('error handling', () => {
    it('malformed JSON (starts with {) → ErrorEvent with code parse_error', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse('{ invalid json', 0) as [ErrorEvent];
      expect(ev).toMatchObject({
        type: 'error', code: 'parse_error', detail: expect.stringContaining('Malformed JSON'),
      });
    });

    it('plaintext line (no leading {) → TextEvent', () => {
      const parse = createCursorStreamParser();
      const [ev] = parse('startup message', 0) as [TextEvent];
      expect(ev).toMatchObject({ type: 'text', text: 'startup message\n' });
    });
  });

  describe('empty and whitespace lines', () => {
    it('empty line → no events', () => {
      const parse = createCursorStreamParser();
      const evs = parse('', 0);
      expect(evs).toHaveLength(0);
    });

    it('whitespace-only line → no events', () => {
      const parse = createCursorStreamParser();
      const evs = parse('   ', 0);
      expect(evs).toHaveLength(0);
    });
  });

  describe('seq numbering', () => {
    it('preserves and increments seq across multiple events', () => {
      const parse = createCursorStreamParser();
      const ev1s = parse(line({
        type: 'system', subtype: 'init', session_id: 'chat-1',
      }), 10);
      const ev2s = parse(line({
        type: 'assistant', text: 'hello', timestamp_ms: 100, model_call_id: 'call-1',
      }), 10 + ev1s.length);
      expect(ev1s[0].seq).toBe(10);
      expect(ev2s[0].seq).toBe(11);
    });
  });

  describe('timestamp', () => {
    it('each event has a timestamp', () => {
      const parse = createCursorStreamParser();
      const before = Date.now();
      const [ev] = parse(line({ type: 'system', subtype: 'init', session_id: 'chat-1' }), 0);
      const after = Date.now();
      expect(ev.timestamp).toBeGreaterThanOrEqual(before);
      expect(ev.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
