#!/usr/bin/env node
/**
 * Fake Antigravity CLI binary for integration tests — speaks stream-json NDJSON.
 * Reads prompt via -p flag, writes NDJSON stream-json events to stdout.
 *
 * Scenarios (FAKE_SCENARIO env var):
 *   golden-path        normal completion with message_delta and done events
 *   resume             with --conversation <id> arg, validates the arg and returns completion
 *   stall              emits one message_delta, then stalls; exits on SIGTERM
 *   ignore-sigterm     emits one message_delta, then stalls; ignores SIGTERM
 *   nonzero-exit       emits one message, then exits with code 1
 */
import { parseArgs } from 'node:util';

const scenario = process.env.FAKE_SCENARIO ?? 'golden-path';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const { values: args } = parseArgs({
  options: {
    p: { type: 'string' },
    'output-format': { type: 'string' },
    'dangerously-skip-permissions': { type: 'boolean' },
    conversation: { type: 'string' },
    agent: { type: 'string' },
  },
  allowPositionals: false,
});

const prompt = args.p;
if (!prompt) {
  process.stderr.write('Error: -p <prompt> is required\n');
  process.exit(1);
}

if (scenario === 'resume' && !args.conversation) {
  process.stderr.write('Error: resume scenario requires --conversation <id>\n');
  process.exit(1);
}

// Emit the basic event stream
const sessionId = scenario === 'resume' ? 'agy-resumed-sess-xyz789' : 'agy-sess-abc123';

// Emit init event (produces ReadyEvent)
emit({
  event: 'init',
  conversation_id: sessionId,
  init: {
    model: 'claude-opus-4',
    tools: [],
  },
});

if (scenario === 'stall') {
  emit({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      text_delta: 'Starting...\n',
    },
  });
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 30_000);
}

if (scenario === 'ignore-sigterm') {
  emit({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      text_delta: 'Starting...\n',
    },
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
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          text_delta: 'Hello from Antigravity!\n',
        },
      });
      emit({
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          text_delta: 'Here is the answer.\n',
        },
      });
      emit({
        event: 'result',
        result: {
          conversation_id: sessionId,
          status: 'success',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
          duration_seconds: 1.5,
          num_turns: 1,
        },
      });
      break;
    }
    case 'nonzero-exit': {
      // Emit one message before exiting with code 1
      emit({
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          text_delta: 'Starting response...\n',
        },
      });
      process.exit(1);
      break;
    }
    default: {
      process.stderr.write(`Unknown FAKE_SCENARIO: ${scenario}\n`);
      process.exitCode = 1;
    }
  }
}
