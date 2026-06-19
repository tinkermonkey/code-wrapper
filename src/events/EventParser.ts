import type {
  ClaudeEvent,
  TextEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  ReadyEvent,
  RetryEvent,
  DoneEvent,
  ErrorEvent,
  RawEvent,
} from './types.js';

// Raw shapes from --output-format stream-json --verbose --print
interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawCliEvent {
  type: string;
  subtype?: string;
  // system/init
  session_id?: string;
  model?: string;
  tools?: Array<{ name?: string }>;
  // system/api_retry
  attempt?: number;
  delay_ms?: number;
  error?: string;
  // tool_result (direct, from --verbose)
  tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
  is_error?: boolean;
  // result
  usage?: RawUsage;
}

/**
 * Parse one line of --output-format stream-json output into zero or more
 * normalized ClaudeEvents.
 *
 * All raw event types are handled. Unrecognized types surface as RawEvent so
 * no event is ever silently discarded.
 *
 * Lines starting with '{' that fail JSON.parse → ErrorEvent { code: 'parse_error' }
 * Other plaintext lines (startup noise, banners) → TextEvent
 */
export function parseCliLine(line: string, nextSeq: number): ClaudeEvent[] {
  const timestamp = Date.now();
  let raw: RawCliEvent;
  let seq = nextSeq;

  try {
    raw = JSON.parse(line) as RawCliEvent;
  } catch {
    if (line.trimStart().startsWith('{')) {
      return [{
        seq, timestamp, type: 'error', code: 'parse_error',
        detail: `Malformed JSON: ${line.slice(0, 200)}`,
      } satisfies ErrorEvent];
    }
    return [{ seq, timestamp, type: 'text', text: line + '\n' } satisfies TextEvent];
  }

  const events: ClaudeEvent[] = [];

  if (raw.type === 'system') {
    if (raw.subtype === 'init') {
      events.push({
        seq: seq++, timestamp, type: 'ready',
        sessionId: raw.session_id ?? '',
        ...(raw.model !== undefined && { model: raw.model }),
        ...(raw.tools !== undefined && {
          tools: raw.tools.map(t => t.name ?? '').filter(n => n.length > 0),
        }),
      } satisfies ReadyEvent);
    } else if (raw.subtype === 'api_retry') {
      events.push({
        seq: seq++, timestamp, type: 'retry',
        attempt: raw.attempt ?? 1,
        ...(raw.delay_ms !== undefined && { delayMs: raw.delay_ms }),
        ...(raw.error !== undefined && { error: raw.error }),
      } satisfies RetryEvent);
    } else {
      events.push({
        seq: seq++, timestamp, type: 'raw',
        rawType: raw.type, rawSubtype: raw.subtype,
        data: raw as unknown,
      } satisfies RawEvent);
    }

  } else if (raw.type === 'assistant') {
    const msg = (raw as unknown as { message?: { content?: RawContentBlock[] } }).message;
    const blocks = msg?.content ?? [];
    if (blocks.length === 0) {
      // Empty content array — preserve rather than silently discard
      events.push({
        seq: seq++, timestamp, type: 'raw',
        rawType: raw.type, data: raw as unknown,
      } satisfies RawEvent);
    } else {
      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          events.push({
            seq: seq++, timestamp, type: 'thinking', thinking: block.thinking,
          } satisfies ThinkingEvent);
        } else if (block.type === 'text' && block.text) {
          events.push({ seq: seq++, timestamp, type: 'text', text: block.text } satisfies TextEvent);
        } else if (block.type === 'tool_use' && block.id && block.name) {
          events.push({
            seq: seq++, timestamp, type: 'tool_use',
            id: block.id, name: block.name, input: block.input ?? {},
          } satisfies ToolUseEvent);
        } else {
          // server_tool_use, redacted_thinking, or any future block type
          events.push({
            seq: seq++, timestamp, type: 'raw',
            rawType: raw.type, rawSubtype: block.type,
            data: block as unknown,
          } satisfies RawEvent);
        }
      }
    }

  } else if (raw.type === 'tool_result') {
    // Direct top-level tool_result event emitted with --verbose
    const output = (raw.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('');
    events.push({
      seq: seq++, timestamp, type: 'tool_result',
      toolUseId: raw.tool_use_id ?? '',
      isError: raw.is_error ?? false,
      output,
    } satisfies ToolResultEvent);

  } else if (raw.type === 'user') {
    // Always preserve the full user turn as RawEvent.
    events.push({
      seq: seq++, timestamp, type: 'raw',
      rawType: raw.type, data: raw as unknown,
    } satisfies RawEvent);

    // Also extract any tool_result blocks as typed ToolResultEvents, so
    // callers receive them even when --verbose top-level events are absent.
    type UserBlock = {
      type: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    const userContent = (raw as unknown as {
      message?: { content?: UserBlock[] };
    }).message?.content ?? [];

    for (const block of userContent) {
      if (block.type !== 'tool_result') continue;
      let output = '';
      if (typeof block.content === 'string') {
        output = block.content;
      } else if (Array.isArray(block.content)) {
        output = (block.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === 'text')
          .map(c => c.text ?? '')
          .join('');
      }
      events.push({
        seq: seq++, timestamp, type: 'tool_result',
        toolUseId: block.tool_use_id ?? '',
        isError: block.is_error ?? false,
        output,
      } satisfies ToolResultEvent);
    }

  } else if (raw.type === 'result') {
    const u = raw.usage;
    events.push({
      seq: seq++, timestamp, type: 'done',
      sessionId: raw.session_id ?? '',
      usage: u
        ? {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            ...(u.cache_read_input_tokens !== undefined && {
              cacheReadInputTokens: u.cache_read_input_tokens,
            }),
            ...(u.cache_creation_input_tokens !== undefined && {
              cacheCreationInputTokens: u.cache_creation_input_tokens,
            }),
          }
        : undefined,
    } satisfies DoneEvent);

  } else if (raw.type === 'rate_limit_event') {
    const r = raw as unknown as { reset_at?: string; retry_after?: number };
    const detail = r.reset_at
      ? `Rate limit — resets at ${r.reset_at}`
      : r.retry_after !== undefined
      ? `Rate limit — retry after ${r.retry_after}s`
      : 'Rate limit hit';
    events.push({ seq: seq++, timestamp, type: 'error', code: 'rate_limit', detail } satisfies ErrorEvent);

  } else if (
    raw.type === 'error' ||
    raw.type === 'error_detail' ||
    raw.type === 'error_event'
  ) {
    const r = raw as unknown as { message?: string; error?: string };
    const detail = r.message ?? r.error ?? `CLI ${raw.type}`;
    events.push({ seq: seq++, timestamp, type: 'error', code: 'cli_error', detail } satisfies ErrorEvent);

  } else {
    // Generic fallback: no events are ever silently lost
    events.push({
      seq: seq++, timestamp, type: 'raw',
      rawType: raw.type,
      ...(raw.subtype !== undefined && { rawSubtype: raw.subtype }),
      data: raw as unknown,
    } satisfies RawEvent);
  }

  return events;
}
