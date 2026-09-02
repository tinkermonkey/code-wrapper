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
  ErrorCode,
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
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
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
    // Direct top-level tool_result event emitted with --verbose (always active).
    // This is the canonical ToolResultEvent source — the corresponding user-turn
    // RawEvent below is the complement, not a duplicate.
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
    // Full user turn preserved as RawEvent. The CLI emits a top-level
    // tool_result event (handled above) for each tool result when --verbose
    // is active, which is always the case via buildArgs(). Extracting
    // ToolResultEvents here too would produce duplicates.
    events.push({
      seq: seq++, timestamp, type: 'raw',
      rawType: raw.type, data: raw as unknown,
    } satisfies RawEvent);

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
      ...(raw.result !== undefined && { resultText: raw.result }),
      ...(raw.is_error !== undefined && { isError: raw.is_error }),
      ...(raw.duration_ms !== undefined && { durationMs: raw.duration_ms }),
      ...(raw.total_cost_usd !== undefined && { totalCostUsd: raw.total_cost_usd }),
      ...(raw.num_turns !== undefined && { numTurns: raw.num_turns }),
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

/**
 * Stateful parser factory for Google Gemini's `--output-format stream-json` NDJSON stream.
 *
 * Returns a closure that parses NDJSON JSON lines with an `event` discriminator into
 * normalized ClaudeEvents. Call once per CliProcess.run() invocation so all lines
 * in a session share the same conversationId state.
 *
 * Google Gemini event → ClaudeEvent mapping:
 *   init                                           → ReadyEvent with sessionId from conversation_id
 *   step_update (agent_response + text_delta)     → TextEvent
 *   step_update (agent_response, no text_delta)   → RawEvent (metadata-only)
 *   step_update (tool, ACTIVE)                    → ToolUseEvent
 *   step_update (tool, DONE)                      → ToolResultEvent
 *   step_update (other step_type)                 → RawEvent (zero-loss fallback)
 *   result                                        → DoneEvent
 *   error                                         → ErrorEvent with code from regex heuristics
 *   Any other event value                         → RawEvent with rawType: 'gemini/<event>'
 *   Malformed JSON (line starts with '{')         → ErrorEvent { code: 'parse_error' }
 *   Plaintext lines                               → TextEvent
 */
export function createGeminiStreamParser(): (line: string, nextSeq: number) => ClaudeEvent[] {
  let conversationId = '';

  return function parseLine(line: string, nextSeq: number): ClaudeEvent[] {
    if (!line.trim()) return [];
    const timestamp = Date.now();
    let seq = nextSeq;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;

    try {
      msg = JSON.parse(line);
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
    const event = msg.event as string | undefined;

    if (event === 'init') {
      const initData = msg.init as Record<string, unknown> | undefined;
      conversationId = (msg.conversation_id as string) || '';
      const toolsArray = Array.isArray(initData?.tools)
        ? (initData.tools as Array<Record<string, unknown>>).map(t => (t?.name as string) ?? '').filter(n => n.length > 0)
        : undefined;
      events.push({
        seq: seq++, timestamp, type: 'ready',
        sessionId: conversationId,
        ...(typeof initData?.model === 'string' && { model: initData.model }),
        ...(toolsArray && { tools: toolsArray }),
      } satisfies ReadyEvent);

    } else if (event === 'step_update') {
      const stepUpdate = msg.step_update as Record<string, unknown> | undefined;
      const stepType = stepUpdate?.step_type as string | undefined;
      const state = stepUpdate?.state as string | undefined;

      if (stepType === 'agent_response') {
        const textDelta = stepUpdate?.text_delta as string | undefined;
        if (textDelta !== undefined) {
          events.push({ seq: seq++, timestamp, type: 'text', text: textDelta } satisfies TextEvent);
        } else {
          // Metadata-only agent response (no text_delta, e.g. thinking, citations) — preserve as raw
          events.push({
            seq: seq++, timestamp, type: 'raw',
            rawType: 'gemini/step_update', rawSubtype: 'agent_response',
            data: msg as unknown,
          } satisfies RawEvent);
        }

      } else if (stepType === 'tool') {
        const toolInfo = stepUpdate?.tool_info as Record<string, unknown> | undefined;
        const toolUseId = toolInfo?.tool_use_id as string | undefined;

        if (state === 'ACTIVE' && toolUseId) {
          events.push({
            seq: seq++, timestamp, type: 'tool_use',
            id: toolUseId,
            name: (toolInfo?.name as string) || '',
            input: (toolInfo?.parameters as unknown) || {},
          } satisfies ToolUseEvent);

        } else if (state === 'DONE' && toolUseId) {
          const output = toolInfo?.output as string | undefined;
          const error = toolInfo?.error as string | undefined;
          events.push({
            seq: seq++, timestamp, type: 'tool_result',
            toolUseId,
            isError: !!error,
            output: error || output || '',
          } satisfies ToolResultEvent);
        } else {
          // Unrecognized tool state or missing toolUseId — preserve as raw
          events.push({
            seq: seq++, timestamp, type: 'raw',
            rawType: 'gemini/step_update', rawSubtype: `tool_${state}`,
            data: msg as unknown,
          } satisfies RawEvent);
        }

      } else {
        // Unrecognized step_type — preserve as raw (zero-loss fallback)
        events.push({
          seq: seq++, timestamp, type: 'raw',
          rawType: 'gemini/step_update', rawSubtype: stepType,
          data: msg as unknown,
        } satisfies RawEvent);
      }

    } else if (event === 'result') {
      const result = msg.result as Record<string, unknown> | undefined;
      const usage = result?.usage as Record<string, number> | undefined;
      const status = result?.status as string | undefined;

      events.push({
        seq: seq++, timestamp, type: 'done',
        sessionId: (result?.conversation_id as string) || conversationId,
        ...(usage && {
          usage: {
            inputTokens: (usage.input_tokens ?? 0) as number,
            outputTokens: (usage.output_tokens ?? 0) as number,
          },
        }),
        ...(typeof result?.duration_seconds === 'number' && {
          durationMs: result.duration_seconds * 1000,
        }),
        ...(typeof result?.num_turns === 'number' && { numTurns: result.num_turns }),
        ...(status !== undefined && status !== 'success' && { isError: true }),
      } satisfies DoneEvent);

    } else if (event === 'error') {
      const error = msg.error as Record<string, unknown> | undefined;
      const message = (error?.message as string) || '';
      const code = classifyGeminiError(message);

      events.push({
        seq: seq++, timestamp, type: 'error',
        code, detail: message,
      } satisfies ErrorEvent);

    } else {
      // Unrecognized event value — preserve as raw so nothing is silently lost
      events.push({
        seq: seq++, timestamp, type: 'raw',
        rawType: `gemini/${event}`,
        data: msg as unknown,
      } satisfies RawEvent);
    }

    return events;
  };
}

/**
 * Classify a Google Gemini error message via regex heuristics.
 * Google Gemini provides no structured error code, so we match against message text.
 */
function classifyGeminiError(message: string): ErrorCode {
  const STALE_SESSION_RE = /conversation\s+not\s+found|no\s+conversation/i;
  const RATE_LIMIT_RE = /rate.?limit|quota.*exceeded/i;

  if (STALE_SESSION_RE.test(message)) return 'stale_session' as const;
  if (RATE_LIMIT_RE.test(message)) return 'rate_limit' as const;
  return 'cli_error' as const;
}

/**
 * Stateful ACP parser factory for the GitHub Copilot CLI (`copilot --acp --stdio`).
 *
 * Returns a closure that parses NDJSON JSON-RPC lines from the ACP protocol
 * into normalized ClaudeEvents. Call once per CliProcess.run() invocation so
 * all lines in a session share the same sessionUuid state.
 *
 * Resumed sessions use the exact same handshake as new ones (initialize →
 * session/new → session/prompt): the CLI is launched with --resume=<uuid> to
 * load the persisted context, but session/new still hands back a NEW session
 * UUID rather than the resumed one, so there is nothing resume-specific left
 * for this parser to special-case.
 *
 * ACP notification → ClaudeEvent mapping:
 *   session/new result (result.sessionId)  → ReadyEvent
 *   session/update (agent_message_chunk)    → TextEvent
 *   session/update (tool_call)              → ToolUseEvent, or RawEvent if toolCallId is missing
 *   session/update (tool_call_update, terminal status) → ToolResultEvent, or RawEvent if toolCallId is missing
 *   assistant.message_delta notification    → TextEvent
 *   assistant.message notification          → TextEvent
 *   session.idle                            → DoneEvent
 *   session/prompt ack (result.stopReason)  → DoneEvent { stopReason }
 *   permission/request                      → RawEvent
 *   ACP error response (msg.error)          → ErrorEvent { code: 'cli_error' }
 *   Other responses/notifications           → RawEvent (zero-loss)
 *   Unrecognized structure                  → RawEvent { rawType: 'acp/unknown' }
 */
export function createCopilotAcpParser(): (line: string, nextSeq: number) => ClaudeEvent[] {
  let sessionUuid = '';
  // Tracks whether the initialize handshake ack has been seen, so the
  // session/prompt ack's stopReason (the real-protocol done signal) isn't
  // confused with the initialize ack that always arrives first.
  let initializeAcked = false;

  return function parseLine(line: string, nextSeq: number): ClaudeEvent[] {
    if (!line.trim()) return [];
    const timestamp = Date.now();
    let seq = nextSeq;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [{
        seq, timestamp, type: 'error', code: 'parse_error',
        detail: `Malformed JSON: ${line.slice(0, 200)}`,
      } satisfies ErrorEvent];
    }

    const events: ClaudeEvent[] = [];

    // session/new response → capture UUID and emit ReadyEvent.
    // Guard with !sessionUuid so this fires at most once per session: prevents
    // a double ReadyEvent if a future ACP version returns sessionId in other
    // responses, and prevents overwriting the captured UUID on a resumed session.
    if (msg.result?.sessionId && !sessionUuid) {
      sessionUuid = msg.result.sessionId as string;
      events.push({ seq: seq++, timestamp, type: 'ready', sessionId: sessionUuid } satisfies ReadyEvent);
      return events;
    }

    // Notifications (no id field — server-push)
    if (msg.method != null && msg.id == null) {
      if (msg.method === 'session/update') {
        // Real copilot v1.x: agent_message_chunk with update.content.text
        const update = msg.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const text = (update?.content?.text ?? '') as string;
          if (text) events.push({ seq: seq++, timestamp, type: 'text', text } satisfies TextEvent);
          return events;
        }
        // Agent invokes a tool (fs edit, shell exec, search, etc.) — toolCallId
        // is the ACP call handle; kind is the closest analog to Claude's tool
        // name (a category like 'edit'/'execute'/'read'), rawInput mirrors
        // Claude's tool_use.input.
        if (update?.sessionUpdate === 'tool_call') {
          const toolCallId = update.toolCallId as string | undefined;
          if (toolCallId) {
            events.push({
              seq: seq++, timestamp, type: 'tool_use',
              id: toolCallId,
              name: String(update.kind ?? update.title ?? 'tool'),
              input: update.rawInput ?? {},
            } satisfies ToolUseEvent);
          } else {
            // No toolCallId to correlate a future tool_call_update against —
            // preserve the raw message rather than silently dropping it.
            events.push({
              seq: seq++, timestamp, type: 'raw',
              rawType: 'acp/tool_call_missing_id', data: msg as unknown,
            } satisfies RawEvent);
          }
          return events;
        }
        // Terminal status of a previously-announced tool_call. Intermediate
        // ('pending'/'in_progress') updates carry no new information worth
        // surfacing as an event.
        if (update?.sessionUpdate === 'tool_call_update') {
          const toolCallId = update.toolCallId as string | undefined;
          const status = update.status as string | undefined;
          if (toolCallId && (status === 'completed' || status === 'failed')) {
            const rawOutput = update.rawOutput as Record<string, unknown> | undefined;
            const output = typeof rawOutput?.content === 'string'
              ? rawOutput.content
              : JSON.stringify(rawOutput ?? {});
            events.push({
              seq: seq++, timestamp, type: 'tool_result',
              toolUseId: toolCallId, isError: status === 'failed', output,
            } satisfies ToolResultEvent);
          } else if (!toolCallId && (status === 'completed' || status === 'failed')) {
            // Terminal status with nothing to correlate it against — preserve
            // the raw message rather than silently dropping it.
            events.push({
              seq: seq++, timestamp, type: 'raw',
              rawType: 'acp/tool_call_update_missing_id', data: msg as unknown,
            } satisfies RawEvent);
          }
          return events;
        }
        // Fake/legacy: params.type === 'assistant.message_delta' with params.data.deltaContent
        const content = (msg.params?.data?.deltaContent ?? '') as string;
        if (content) events.push({ seq: seq++, timestamp, type: 'text', text: content } satisfies TextEvent);
        return events;
      }
      if (msg.method === 'assistant.message_delta') {
        const content = (msg.params?.data?.deltaContent ?? '') as string;
        if (content) events.push({ seq: seq++, timestamp, type: 'text', text: content } satisfies TextEvent);
        return events;
      }
      if (msg.method === 'assistant.message') {
        const content = (msg.params?.content ?? msg.params?.data?.content ?? '') as string;
        if (content) events.push({ seq: seq++, timestamp, type: 'text', text: content } satisfies TextEvent);
        return events;
      }
      if (msg.method === 'session.idle') {
        events.push({ seq: seq++, timestamp, type: 'done', sessionId: sessionUuid } satisfies DoneEvent);
        return events;
      }
      if (msg.method === 'permission/request') {
        events.push({
          seq: seq++, timestamp, type: 'raw',
          rawType: 'permission/request', data: msg as unknown,
        } satisfies RawEvent);
        return events;
      }
      events.push({
        seq: seq++, timestamp, type: 'raw',
        rawType: msg.method as string, data: msg as unknown,
      } satisfies RawEvent);
      return events;
    }

    // Error responses
    if (msg.error) {
      const detail = (msg.error.message as string | undefined)
        ?? `ACP error (code ${msg.error.code as number | undefined})`;
      events.push({ seq: seq++, timestamp, type: 'error', code: 'cli_error', detail } satisfies ErrorEvent);
      return events;
    }

    // Other responses (initialize ack, session/prompt ack, etc.)
    if (msg.id !== undefined) {
      // The initialize ack always arrives first and only confirms the ACP
      // handshake; it never carries a sessionId, so it can't hit the
      // session/new branch above.
      if (!initializeAcked) {
        initializeAcked = true;
      } else if ((msg.result as Record<string, unknown>)?.stopReason !== undefined) {
        // Real copilot v1.x: session/prompt ack with stopReason is the done signal.
        // The fake/legacy protocol uses session.idle instead (handled above).
        const stopReason = (msg.result as Record<string, unknown>).stopReason as string;
        events.push({
          seq: seq++, timestamp, type: 'done', sessionId: sessionUuid, stopReason,
        } satisfies DoneEvent);
        return events;
      }
      events.push({
        seq: seq++, timestamp, type: 'raw',
        rawType: 'acp/response', data: msg as unknown,
      } satisfies RawEvent);
      return events;
    }

    // Unrecognized structure — emit as raw so no message is ever silently lost
    events.push({
      seq: seq++, timestamp, type: 'raw',
      rawType: 'acp/unknown', data: msg as unknown,
    } satisfies RawEvent);
    return events;
  };
}

/**
 * Stateful stream parser factory for the Cursor CLI (`agent --output-format stream-json`).
 *
 * Returns a closure that parses Cursor's NDJSON stream into normalized ClaudeEvents.
 * Call once per CliProcess.run() invocation so all lines in a session share the same
 * deduplication state.
 *
 * Cursor event → ClaudeEvent mapping:
 *   system/init                                      → ReadyEvent with sessionId, model
 *   assistant (with deduplication of partial output) → TextEvent
 *   tool_call/started (with polymorphic tool keys)   → ToolUseEvent
 *   tool_call/completed (with polymorphic tool keys) → ToolResultEvent
 *   result/success                                   → DoneEvent with sessionId, durationMs
 *   All other event types                            → RawEvent (zero-loss fallback)
 *   Malformed JSON (line starts with '{')            → ErrorEvent { code: 'parse_error' }
 *   Plaintext lines                                  → TextEvent
 *
 * Note: Cursor headless mode does not emit thinking content, so no ThinkingEvent is produced.
 */
export function createCursorStreamParser(): (line: string, nextSeq: number) => ClaudeEvent[] {
  // Track the last assistant event's timestamp_ms and model_call_id to deduplicate
  // partial output events. Cursor emits multiple forms of assistant events; we keep
  // only the canonical one (the one with model_call_id).
  let lastAssistantTimestamp: number | null = null;
  let lastAssistantModelCallId: string | null = null;

  return function parseLine(line: string, nextSeq: number): ClaudeEvent[] {
    if (!line.trim()) return [];
    const timestamp = Date.now();
    let seq = nextSeq;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;

    try {
      msg = JSON.parse(line);
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
    const type = msg.type as string | undefined;

    if (type === 'system' && msg.subtype === 'init') {
      lastAssistantTimestamp = null;
      lastAssistantModelCallId = null;
      events.push({
        seq: seq++, timestamp, type: 'ready',
        sessionId: (msg.session_id as string) ?? '',
        ...(typeof msg.model === 'string' && { model: msg.model }),
      } satisfies ReadyEvent);

    } else if (type === 'assistant') {
      // Cursor emits multiple assistant events under --stream-partial-output:
      // - Events with timestamp_ms but no model_call_id are partial/intermediate forms
      // - The canonical form has a model_call_id and represents a complete chunk
      // Filter out partial events (no model_call_id), keeping only canonical forms.
      // Deduplicate by tracking (timestamp_ms, model_call_id) pairs.
      const assistantTimestamp = msg.timestamp_ms as number | null;
      const assistantModelCallId = msg.model_call_id as string | null;

      // Skip partial events (no model_call_id) — they're intermediate updates
      if (!assistantModelCallId) {
        return events;
      }

      // Emit canonical events (with model_call_id) only if new
      const isNew = lastAssistantTimestamp !== assistantTimestamp
        || lastAssistantModelCallId !== assistantModelCallId;

      if (isNew) {
        lastAssistantTimestamp = assistantTimestamp;
        lastAssistantModelCallId = assistantModelCallId;
        const text = (msg.text ?? '') as string;
        if (text) {
          events.push({ seq: seq++, timestamp, type: 'text', text } satisfies TextEvent);
        }
      }

    } else if (type === 'tool_call' && msg.subtype === 'started') {
      const toolCallId = msg.tool_call_id as string | undefined;
      if (toolCallId) {
        const { name, input } = extractCursorToolInfo(msg);
        events.push({
          seq: seq++, timestamp, type: 'tool_use',
          id: toolCallId,
          name,
          input: input ?? {},
        } satisfies ToolUseEvent);
      } else {
        // Missing tool_call_id — preserve as raw
        events.push({
          seq: seq++, timestamp, type: 'raw',
          rawType: type, rawSubtype: msg.subtype,
          data: msg as unknown,
        } satisfies RawEvent);
      }

    } else if (type === 'tool_call' && msg.subtype === 'completed') {
      const toolCallId = msg.tool_call_id as string | undefined;
      if (toolCallId) {
        const { output, isError } = extractCursorToolResult(msg);
        events.push({
          seq: seq++, timestamp, type: 'tool_result',
          toolUseId: toolCallId,
          isError,
          output,
        } satisfies ToolResultEvent);
      } else {
        // Missing tool_call_id — preserve as raw
        events.push({
          seq: seq++, timestamp, type: 'raw',
          rawType: type, rawSubtype: msg.subtype,
          data: msg as unknown,
        } satisfies RawEvent);
      }

    } else if (type === 'result' && msg.subtype === 'success') {
      events.push({
        seq: seq++, timestamp, type: 'done',
        sessionId: (msg.session_id as string) ?? '',
        ...(typeof msg.duration_ms === 'number' && { durationMs: msg.duration_ms }),
        ...(typeof msg.result === 'string' && { resultText: msg.result }),
      } satisfies DoneEvent);

    } else {
      // Generic fallback: no events are ever silently lost
      events.push({
        seq: seq++, timestamp, type: 'raw',
        rawType: type ?? 'unknown',
        ...(msg.subtype !== undefined && { rawSubtype: msg.subtype }),
        data: msg as unknown,
      } satisfies RawEvent);
    }

    return events;
  };
}

/**
 * Extract tool name and input from a Cursor tool_call/started event.
 * Cursor uses polymorphic keys per tool type (readToolCall, writeToolCall, bashToolCall, etc.).
 * Normalize to a single name field.
 */
function extractCursorToolInfo(msg: Record<string, unknown>) {
  const toolTypeMap: Record<string, string> = {
    readToolCall: 'read',
    writeToolCall: 'write',
    bashToolCall: 'bash',
    searchToolCall: 'search',
    editToolCall: 'edit',
    codeSearchToolCall: 'codeSearch',
    webSearchToolCall: 'webSearch',
  };

  let name = 'unknown';
  let input = null;

  for (const [key, toolName] of Object.entries(toolTypeMap)) {
    const toolData = msg[key] as Record<string, unknown> | undefined;
    if (toolData) {
      name = toolName;
      input = toolData.input ?? null;
      break;
    }
  }

  return { name, input };
}

/**
 * Extract output and isError from a Cursor tool_call/completed event.
 * Different tool types have different result structures.
 */
function extractCursorToolResult(msg: Record<string, unknown>): { output: string; isError: boolean } {
  const toolTypeMap: Record<string, string> = {
    readToolCall: 'read',
    writeToolCall: 'write',
    bashToolCall: 'bash',
    searchToolCall: 'search',
    editToolCall: 'edit',
    codeSearchToolCall: 'codeSearch',
    webSearchToolCall: 'webSearch',
  };

  for (const key of Object.keys(toolTypeMap)) {
    const toolData = msg[key] as Record<string, unknown> | undefined;
    if (toolData) {
      const result = toolData.result;
      if (typeof result === 'string') {
        return { output: result, isError: false };
      }
      if (typeof result === 'object' && result !== null) {
        const resultObj = result as Record<string, unknown>;
        const output = (resultObj.output ?? resultObj.error ?? '') as string;
        const isError = 'error' in resultObj && !!resultObj.error;
        return { output, isError };
      }
    }
  }

  return { output: '', isError: false };
}
