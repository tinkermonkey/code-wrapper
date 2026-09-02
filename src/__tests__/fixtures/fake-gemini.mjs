#!/usr/bin/env node
/**
 * Fake Google Gemini CLI binary for integration tests — speaks Google Gemini NDJSON format.
 * Reads prompt via stdin, writes NDJSON events to stdout.
 *
 * Scenarios (FAKE_SCENARIO env var):
 *   golden-path        normal completion with init, step_update, and result events
 *   resume             with --conversation <id> arg, validates the arg and returns completion
 *   stall              emits one step_update, then stalls; exits on SIGTERM
 *   ignore-sigterm     emits one step_update, then stalls; ignores SIGTERM
 *   nonzero-exit       emits one step_update, then exits with code 1
 *   stale-session      emits error event with "conversation not found" message
 *   rate-limit         emits error event with "rate limit" message
 *   error-event        emits generic error event
 */
import { parseArgs } from 'node:util';

const scenario = process.env.FAKE_SCENARIO ?? 'golden-path';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const { values: args } = parseArgs({
  options: {
    'output-format': { type: 'string' },
    'dangerously-skip-permissions': { type: 'boolean' },
    conversation: { type: 'string' },
    agent: { type: 'string' },
  },
  allowPositionals: false,
});

// Read prompt from stdin
let prompt = '';
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
await new Promise((resolve) => {
  process.stdin.on('end', () => {
    prompt = Buffer.concat(chunks).toString('utf-8');
    if (!prompt) {
      process.stderr.write('Error: prompt from stdin is required\n');
      process.exit(1);
    }
    resolve();
  });
});

if (scenario === 'resume' && !args.conversation) {
  process.stderr.write('Error: resume scenario requires --conversation <id>\n');
  process.exit(1);
}

// Validate flag expectations for test scenarios
const expectedSkipPermissions = process.env.FAKE_EXPECT_SKIP_PERMISSIONS;
if (expectedSkipPermissions === 'true' && !args['dangerously-skip-permissions']) {
  process.stderr.write('Error: expected --dangerously-skip-permissions flag but it was not provided\n');
  process.exit(1);
}
if (expectedSkipPermissions === 'false' && args['dangerously-skip-permissions']) {
  process.stderr.write('Error: expected NO --dangerously-skip-permissions flag but it was provided\n');
  process.exit(1);
}

const expectedAgent = process.env.FAKE_EXPECT_AGENT;
if (expectedAgent && args.agent !== expectedAgent) {
  process.stderr.write(`Error: expected --agent ${expectedAgent} but got ${args.agent ?? 'nothing'}\n`);
  process.exit(1);
}

// Emit the basic event stream
const sessionId = scenario === 'resume' ? 'gemini-resumed-sess-xyz789' : 'gemini-sess-abc123';

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
          text_delta: 'Hello from Google Gemini!\n',
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
    case 'stale-session': {
      // Emit error event with stale session message
      emit({
        event: 'error',
        error: {
          message: 'Conversation not found with session ID: ' + sessionId,
        },
      });
      process.exit(1);
      break;
    }
    case 'rate-limit': {
      // Emit error event with rate limit message
      emit({
        event: 'error',
        error: {
          message: 'Rate limit exceeded: please wait before trying again',
        },
      });
      process.exit(1);
      break;
    }
    case 'error-event': {
      // Emit generic error event
      emit({
        event: 'error',
        error: {
          message: 'An unexpected error occurred',
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
