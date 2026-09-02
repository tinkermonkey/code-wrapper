#!/usr/bin/env node
/**
 * Fake Cursor CLI binary for integration tests — speaks Cursor NDJSON format.
 * Receives prompt via -p flag (not stdin), writes NDJSON events to stdout.
 *
 * Scenarios (FAKE_SCENARIO env var):
 *   golden-path        normal completion with init, assistant, tool_call, and result events
 *   resume             with --resume <chatId> arg, validates the arg and returns completion
 *   stall              emits one assistant event, then stalls; exits on SIGTERM
 *   ignore-sigterm     emits one assistant event, then stalls; ignores SIGTERM
 *   nonzero-exit       emits one assistant event, then exits with code 1
 *   stale-session      emits stderr message indicating session not found
 *   rate-limit         emits stderr message indicating rate limit
 *   oversized-prompt   fails before emitting any output (handled by CliProcess)
 */
import { parseArgs } from 'node:util';

// For version check (isAvailable detection) — must be handled before parseArgs
if (process.argv.includes('--version')) {
  console.log('Cursor Agent version 0.1.0');
  process.exit(0);
}

const scenario = process.env.FAKE_SCENARIO ?? 'golden-path';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const { values: args } = parseArgs({
  options: {
    'output-format': { type: 'string' },
    'p': { type: 'string' },
    'print': { type: 'string' },
    'workspace': { type: 'string' },
    'force': { type: 'boolean' },
    'resume': { type: 'string' },
    'agent': { type: 'string' },
  },
  allowPositionals: false,
});

// Cursor requires prompt via -p flag
const prompt = args.p || args.print;
if (!prompt) {
  process.stderr.write('Error: prompt is required (use -p <prompt>)\n');
  process.exit(1);
}

if (scenario === 'resume' && !args.resume) {
  process.stderr.write('Error: resume scenario requires --resume <chatId>\n');
  process.exit(1);
}

// Validate flag expectations for test scenarios
const expectedSkipPermissions = process.env.FAKE_EXPECT_SKIP_PERMISSIONS;
if (expectedSkipPermissions === 'true' && !args.force) {
  process.stderr.write('Error: expected --force flag but it was not provided\n');
  process.exit(1);
}
if (expectedSkipPermissions === 'false' && args.force) {
  process.stderr.write('Error: expected NO --force flag but it was provided\n');
  process.exit(1);
}

const expectedAgent = process.env.FAKE_EXPECT_AGENT;
if (expectedAgent && args.agent !== expectedAgent) {
  process.stderr.write(`Error: expected --agent ${expectedAgent} but got ${args.agent ?? 'nothing'}\n`);
  process.exit(1);
}

// Emit the basic event stream
const sessionId = scenario === 'resume' ? 'cursor-resumed-sess-xyz789' : 'cursor-sess-abc123';

// Emit init event (produces ReadyEvent)
emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model: 'claude-opus-4',
  timestamp_ms: Date.now(),
});

if (scenario === 'stall') {
  emit({
    type: 'assistant',
    text: 'Starting...\n',
    timestamp_ms: Date.now(),
    model_call_id: 'call-1',
  });
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 30_000);
}

if (scenario === 'ignore-sigterm') {
  emit({
    type: 'assistant',
    text: 'Starting...\n',
    timestamp_ms: Date.now(),
    model_call_id: 'call-1',
  });
  process.on('SIGTERM', () => { /* intentionally ignored */ });
  setInterval(() => {}, 30_000);
}

// Only run completion logic if not in a stall scenario
if (scenario !== 'stall' && scenario !== 'ignore-sigterm') {
  switch (scenario) {
    case 'golden-path':
    case 'resume': {
      emit({
        type: 'assistant',
        text: 'Hello from Cursor!\n',
        timestamp_ms: Date.now(),
        model_call_id: 'call-1',
      });
      emit({
        type: 'tool_call',
        subtype: 'started',
        tool_call_id: 'tool-1',
        timestamp_ms: Date.now(),
        readToolCall: {
          input: { path: '/test/file.txt' },
        },
      });
      emit({
        type: 'tool_call',
        subtype: 'completed',
        tool_call_id: 'tool-1',
        timestamp_ms: Date.now(),
        readToolCall: {
          result: 'File contents\n',
        },
      });
      emit({
        type: 'assistant',
        text: 'Here is the answer.\n',
        timestamp_ms: Date.now(),
        model_call_id: 'call-2',
      });
      emit({
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        duration_ms: 1500,
        timestamp_ms: Date.now(),
      });
      break;
    }
    case 'nonzero-exit': {
      // Emit one message before exiting with code 1
      emit({
        type: 'assistant',
        text: 'Starting response...\n',
        timestamp_ms: Date.now(),
        model_call_id: 'call-1',
      });
      process.exit(1);
      break;
    }
    case 'stale-session': {
      // Emit stderr message indicating stale session
      process.stderr.write('Error: chat not found with session ID: ' + sessionId + '\n');
      process.exit(1);
      break;
    }
    case 'rate-limit': {
      // Emit stderr message indicating rate limit (matching RATE_LIMIT_RE pattern)
      process.stderr.write('Error: you hit your limit, resets at 3:45 pm\n');
      process.exit(1);
      break;
    }
    default: {
      process.stderr.write(`Unknown FAKE_SCENARIO: ${scenario}\n`);
      process.exitCode = 1;
    }
  }
}
