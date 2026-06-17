import type {
  ClaudeEvent,
  TextEvent,
  ToolUseEvent,
  ToolResultEvent,
  DoneEvent,
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
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Parse one line of --output-format stream-json output into zero or more
 * normalized ClaudeEvents.
 *
 * One raw event can yield multiple normalized events — e.g. an 'assistant'
 * message containing both text and tool_use blocks yields a TextEvent
 * followed by a ToolUseEvent.
 *
 * Non-JSON lines (startup noise, plain-text warnings) are returned as
 * TextEvents so the caller always gets a typed stream regardless of CLI
 * version quirks.
 */
export function parseCliLine(line: string, nextSeq: number): ClaudeEvent[] {
  const timestamp = Date.now();
  let raw: RawCliEvent;
  let seq = nextSeq;

  try {
    raw = JSON.parse(line) as RawCliEvent;
  } catch {
    // Non-JSON line — surface as text so nothing is silently dropped
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
    events.push({
      seq: seq++,
      timestamp,
      type: 'done',
      sessionId: raw.session_id ?? '',
      usage: raw.usage
        ? {
            inputTokens: raw.usage.input_tokens ?? 0,
            outputTokens: raw.usage.output_tokens ?? 0,
          }
        : undefined,
    } satisfies DoneEvent);
  }
  // 'user' and 'system' events are intentionally dropped — they are echoes
  // of the input or internal CLI bookkeeping, not consumer-facing events.

  return events;
}
