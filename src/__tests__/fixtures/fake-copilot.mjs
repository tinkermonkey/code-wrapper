#!/usr/bin/env node
/**
 * Fake Copilot CLI binary for integration tests — speaks ACP (copilot --acp --stdio).
 * Reads NDJSON JSON-RPC from stdin, writes NDJSON responses to stdout.
 *
 * Scenarios (FAKE_SCENARIO env var):
 *   golden-path    full handshake + two message_delta chunks + session.idle
 *   stall          full handshake + one message_delta, then stalls; exits on SIGTERM
 *   ignore-sigterm full handshake + one message_delta, then stalls; ignores SIGTERM
 *   nonzero-exit   full handshake, then exits with code 1
 */
import { createInterface } from 'node:readline';

const SESSION_ID = 'copilot-sess-abc123';
const scenario = process.env.FAKE_SCENARIO ?? 'golden-path';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const rl = createInterface({ input: process.stdin, terminal: false });
let promptReceived = false;

for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }

  if (msg.method === 'initialize') {
    emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-01', capabilities: {} } });
  } else if (msg.method === 'session/new') {
    emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION_ID } });
  } else if (msg.method === 'session/prompt') {
    emit({ jsonrpc: '2.0', id: msg.id, result: {} });
    promptReceived = true;

    if (scenario === 'stall') {
      emit({ jsonrpc: '2.0', method: 'session/update', params: { type: 'assistant.message_delta', data: { deltaContent: 'Starting...\n' } } });
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 30_000);
      break;
    }

    if (scenario === 'ignore-sigterm') {
      emit({ jsonrpc: '2.0', method: 'session/update', params: { type: 'assistant.message_delta', data: { deltaContent: 'Starting...\n' } } });
      process.on('SIGTERM', () => { /* intentionally ignored */ });
      setInterval(() => {}, 30_000);
      break;
    }

    // All other scenarios: let the for-await drain naturally (stdin closes)
    break;
  }
}

if (promptReceived && scenario !== 'stall' && scenario !== 'ignore-sigterm') {
  switch (scenario) {
    case 'golden-path': {
      emit({ jsonrpc: '2.0', method: 'session/update', params: { type: 'assistant.message_delta', data: { deltaContent: 'Hello from Copilot!\n' } } });
      emit({ jsonrpc: '2.0', method: 'session/update', params: { type: 'assistant.message_delta', data: { deltaContent: 'Here is the answer.\n' } } });
      emit({ jsonrpc: '2.0', method: 'session.idle', params: { sessionId: SESSION_ID } });
      break;
    }
    case 'nonzero-exit': {
      process.exitCode = 1;
      break;
    }
    default: {
      process.stderr.write(`Unknown FAKE_SCENARIO: ${scenario}\n`);
      process.exitCode = 1;
    }
  }
}
