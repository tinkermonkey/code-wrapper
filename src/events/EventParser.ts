import type {
  ClaudeEvent,
  TextEvent,
  ToolUseEvent,
  ToolResultEvent,
  DoneEvent,
  ErrorEvent,
} from './types.js';

interface RawBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface RawCliEvent {
  type: string;
  // assistant
  message?: { content?: RawBlock[] };
  // tool_result
  tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
  is_error?: boolean;
  // result
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Parse one line of --output-format stream-json output into zero or more
 * normalized ClaudeEvents.
 *
 * One raw event can yield multiple normalized events — e.g. an 'assistant'
 * message containing both text and tool_use blocks yields a TextEvent
 * followed by a ToolUseEvent.
 *
 * Lines starting with '{' that are not valid JSON become ErrorEvent { code: 'parse_error' }.
 * Other non-JSON lines (startup noise, plain-text warnings) become TextEvent.
 */
export function parseCliLine(line: string, nextSeq: number): ClaudeEvent[] {
  const timestamp = Date.now();
  let raw: RawCliEvent;
  let seq = nextSeq;

  try {
    raw = JSON.parse(line) as RawCliEvent;
  } catch {
    // Lines that look like JSON but are malformed surface as parse errors
    if (line.trimStart().startsWith('{')) {
      return [{
        seq, timestamp, type: 'error', code: 'parse_error',
        detail: `Malformed JSON: ${line.slice(0, 200)}`,
      } satisfies ErrorEvent];
    }
    // Plaintext lines (startup noise, warnings) surface as text
    return [{ seq, timestamp, type: 'text', text: line + '\n' } satisfies TextEvent];
  }

  const events: ClaudeEvent[] = [];

  if (raw.type === 'assistant') {
    for (const block of raw.message?.content ?? []) {
      if (block.type === 'text' && block.text) {
        events.push({
          seq: seq++,
          timestamp,
          type: 'text',
          text: block.text,
        } satisfies TextEvent);
      } else if (block.type === 'tool_use' && block.id && block.name) {
        events.push({
          seq: seq++,
          timestamp,
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        } satisfies ToolUseEvent);
      }
    }
  } else if (raw.type === 'tool_result') {
    const output = (raw.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('');
    events.push({
      seq: seq++,
      timestamp,
      type: 'tool_result',
      toolUseId: raw.tool_use_id ?? '',
      isError: raw.is_error ?? false,
      output,
    } satisfies ToolResultEvent);
  } else if (raw.type === 'result') {
    const u = raw.usage;
    events.push({
      seq: seq++,
      timestamp,
      type: 'done',
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
  } else if (
    raw.type === 'error' ||
    raw.type === 'error_detail' ||
    raw.type === 'error_event'
  ) {
    // Inline CLI error events — message field is a string in this context
    const r = raw as unknown as { message?: string; error?: string };
    const detail = r.message ?? r.error ?? `CLI ${raw.type}`;
    events.push({
      seq: seq++,
      timestamp,
      type: 'error',
      code: 'cli_error',
      detail,
    } satisfies ErrorEvent);
  }
  // 'user' and 'system' events are intentionally dropped — they are echoes
  // of the input or internal CLI bookkeeping, not consumer-facing events.

  return events;
}
