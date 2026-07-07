#!/usr/bin/env node
/**
 * Fake Copilot CLI binary for integration tests — speaks ACP (copilot --acp --stdio).
 * Reads NDJSON JSON-RPC from stdin, writes NDJSON responses to stdout.
 *
 * Scenarios (FAKE_SCENARIO env var):
 *   golden-path        full handshake + two message_delta chunks + session.idle
 *   resume             same initialize+session/new+session/prompt handshake as golden path;
 *                       validates --resume=<uuid> arg was passed and returns a NEW sessionId
 *                       (distinct from the resumed uuid), with id=3 on session/prompt
 *   stall              full handshake + one message_delta, then stalls; exits on SIGTERM
 *   ignore-sigterm     full handshake + one message_delta, then stalls; ignores SIGTERM
 *   nonzero-exit       full handshake, then exits with code 1
 *   permission-request full handshake + permission/request notification + normal completion
 */
import { createInterface } from 'node:readline';

const SESSION_ID = 'copilot-sess-abc123';
const RESUMED_SESSION_ID = 'copilot-resumed-sess-xyz789';
const scenario = process.env.FAKE_SCENARIO ?? 'golden-path';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const rl = createInterface({ input: process.stdin, terminal: false });
let promptReceived = false;

for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }

  if (msg.method === 'initialize') {
    emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, capabilities: {} } });
  } else if (msg.method === 'session/new') {
    const sessionId = scenario === 'resume' ? RESUMED_SESSION_ID : SESSION_ID;
    emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
  } else if (msg.method === 'session/prompt') {
    if (scenario === 'resume') {
      const resumeArg = process.argv.find(a => a.startsWith('--resume='));
      if (!resumeArg) {
        process.stderr.write('resume scenario: --resume=<uuid> not found in argv\n');
        process.exitCode = 1;
        process.exit(1);
      }
      if (msg.id !== 3) {
        process.stderr.write(`resume scenario: expected session/prompt id=3 (after initialize+session/new), got id=${msg.id}\n`);
        process.exitCode = 1;
        process.exit(1);
      }
    }
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
    case 'resume': {
      emit({ jsonrpc: '2.0', method: 'session/update', params: { type: 'assistant.message_delta', data: { deltaContent: 'Resumed response.\n' } } });
      emit({ jsonrpc: '2.0', method: 'session.idle', params: {} });
      break;
    }
    case 'permission-request': {
      emit({ jsonrpc: '2.0', method: 'permission/request', params: { tool: 'bash', command: 'ls .' } });
      emit({ jsonrpc: '2.0', method: 'session/update', params: { type: 'assistant.message_delta', data: { deltaContent: 'Done.\n' } } });
      emit({ jsonrpc: '2.0', method: 'session.idle', params: { sessionId: SESSION_ID } });
      break;
    }
    case 'nonzero-exit': {
      // No DoneEvent is ever emitted on this path. The parent now keeps its
      // write end of stdin open until it sees a DoneEvent or this process
      // exits — and Node keeps process.stdin (read side) referenced once
      // readline has consumed it, so this process wouldn't exit on its own
      // without the parent's EOF, and the parent wouldn't send EOF without
      // this process exiting first. Break that cycle by terminating
      // unconditionally instead of falling off the end of the script.
      process.exit(1);
      break;
    }
    default: {
      process.stderr.write(`Unknown FAKE_SCENARIO: ${scenario}\n`);
      process.exitCode = 1;
    }
  }
}
