#!/usr/bin/env node
/**
 * Fake Claude CLI binary for integration tests.
 * Driven by FAKE_SCENARIO env var; inherits the env CliProcess passes to its child.
 *
 * Scenarios:
 *   golden-path        init → text → tool_use → tool_result → result
 *   stall              emits init, then stalls; exits cleanly on SIGTERM
 *   ignore-sigterm     emits init, ignores SIGTERM, only SIGKILL kills it
 *   nonzero-exit       emits init, exits with code 1
 *   stale-session      writes stale-session message to stderr, exits 1
 *   api-retry          emits init + api_retry system event + result
 *   thinking           emits init + thinking block + text block + result
 *   session-resume     accepts --resume <id>, emits init with that session ID + result
 *   rate-limit         emits rate_limit_event on stdout, exits 1
 *   permission-request emits init + assistant with server_tool_use + result
 *   multi-block        emits init + assistant with text+tool_use in one message + result
 */

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Drain stdin so the parent's write-and-close doesn't block.
process.stdin.on('data', () => {});
await new Promise((resolve) => process.stdin.on('end', resolve));

const scenario = process.env.FAKE_SCENARIO ?? 'golden-path';

switch (scenario) {
  case 'golden-path': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-abc123', model: 'claude-sonnet-4-6', tools: [{ name: 'Read' }, { name: 'Write' }] });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from the agent!' }] } });
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/test/file' } }] } });
    emit({ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: 'file contents here' }], is_error: false });
    emit({ type: 'result', session_id: 'sess-abc123', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } });
    // Let the event loop exit naturally (code 0); no process.exit() avoids flushing races.
    break;
  }

  case 'stall': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-stall', model: 'claude-sonnet-4-6', tools: [] });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 30_000); // keep alive until signal
    break;
  }

  case 'ignore-sigterm': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-stubborn', model: 'claude-sonnet-4-6', tools: [] });
    process.on('SIGTERM', () => { /* intentionally ignored */ });
    setInterval(() => {}, 30_000); // only SIGKILL stops this
    break;
  }

  case 'nonzero-exit': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-fail', model: 'claude-sonnet-4-6', tools: [] });
    process.exitCode = 1;
    break;
  }

  case 'stale-session': {
    // No stdout events; just a stderr message that matches STALE_SESSION_RE.
    await new Promise((resolve) =>
      process.stderr.write('Error: No conversation found with session ID old-sess-456\n', resolve)
    );
    process.exitCode = 1;
    break;
  }

  case 'api-retry': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-retry', model: 'claude-sonnet-4-6', tools: [] });
    emit({ type: 'system', subtype: 'api_retry', attempt: 1, delay_ms: 500, error: 'Connection reset by peer' });
    emit({ type: 'result', session_id: 'sess-retry', usage: { input_tokens: 10, output_tokens: 5 } });
    break;
  }

  case 'thinking': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-think', model: 'claude-sonnet-4-6', tools: [] });
    emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Let me think about this carefully...' }] } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done thinking.' }] } });
    emit({ type: 'result', session_id: 'sess-think', usage: { input_tokens: 20, output_tokens: 8 } });
    break;
  }

  case 'session-resume': {
    const resumeIdx = process.argv.indexOf('--resume');
    const resumeId = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : 'sess-resumed';
    emit({ type: 'system', subtype: 'init', session_id: resumeId, model: 'claude-sonnet-4-6', tools: [] });
    emit({ type: 'result', session_id: resumeId, usage: { input_tokens: 10, output_tokens: 5 } });
    break;
  }

  case 'rate-limit': {
    emit({ type: 'rate_limit_event', reset_at: '2026-01-01T00:00:00Z' });
    process.exitCode = 1;
    break;
  }

  case 'permission-request': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-perm', model: 'claude-sonnet-4-6', tools: [] });
    emit({ type: 'assistant', message: { content: [{ type: 'server_tool_use', id: 'stu-1', name: 'web_search', input: { query: 'test' } }] } });
    emit({ type: 'result', session_id: 'sess-perm', usage: { input_tokens: 15, output_tokens: 3 } });
    break;
  }

  case 'multi-block': {
    emit({ type: 'system', subtype: 'init', session_id: 'sess-multi', model: 'claude-sonnet-4-6', tools: [] });
    emit({ type: 'assistant', message: { content: [
      { type: 'text', text: 'Here is the result:' },
      { type: 'tool_use', id: 'tu-multi', name: 'Read', input: { path: '/test' } },
    ] } });
    emit({ type: 'result', session_id: 'sess-multi', usage: { input_tokens: 20, output_tokens: 10 } });
    break;
  }

  default: {
    process.stderr.write(`Unknown FAKE_SCENARIO: ${scenario}\n`);
    process.exitCode = 1;
  }
}
