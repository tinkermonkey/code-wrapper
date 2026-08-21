#!/usr/bin/env node

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliProcess } from '../process/CliProcess.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { runWithRecovery } from '../process/recovery.js';
import type { CliBackend, ProcessOptions } from '../process/types.js';
import type { ClaudeEvent } from '../events/types.js';

interface ExecOptions {
  backend: CliBackend;
  cwd: string;
  prompt: string;
  sessionId?: string;
  isFirstMessage: boolean;
  idleTimeout: number;
  maxTimeout: number;
  skipPermissions: boolean;
  agent?: string;
  mcpConfigPath?: string;
  sessionDir?: string;
  recoverStaleSession: boolean;
  signal?: AbortSignal;
}

function parseArgs(argv: string[]): ExecOptions {
  const opts: Partial<ExecOptions> = {
    backend: 'claude',
    isFirstMessage: true,
    idleTimeout: 300,
    maxTimeout: 3600,
    skipPermissions: false,
    recoverStaleSession: false,
  };

  let prompt: string | undefined;
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--backend':
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        opts.backend = args[++i] as CliBackend;
        break;
      case '--cwd':
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        opts.cwd = args[++i];
        break;
      case '--prompt':
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        prompt = args[++i];
        break;
      case '--session-id':
      case '--resume':
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        opts.sessionId = args[++i];
        opts.isFirstMessage = arg === '--session-id';
        break;
      case '--is-first-message':
        opts.isFirstMessage = true;
        break;
      case '--idle-timeout': {
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        const value = parseInt(args[++i], 10);
        if (isNaN(value)) throw new Error(`${arg} must be a valid number`);
        opts.idleTimeout = value;
        break;
      }
      case '--max-timeout': {
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        const value = parseInt(args[++i], 10);
        if (isNaN(value)) throw new Error(`${arg} must be a valid number`);
        opts.maxTimeout = value;
        break;
      }
      case '--skip-permissions':
        opts.skipPermissions = true;
        break;
      case '--agent':
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        opts.agent = args[++i];
        break;
      case '--mcp-config':
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        opts.mcpConfigPath = args[++i];
        break;
      case '--session-dir':
        if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
        opts.sessionDir = args[++i];
        break;
      case '--recover-stale-session':
        opts.recoverStaleSession = true;
        break;
    }
  }

  // Read prompt from stdin if not provided via --prompt
  if (!prompt) {
    try {
      prompt = readFileSync(0, 'utf-8');
    } catch (err) {
      console.error(`Warning: Failed to read prompt from stdin: ${err instanceof Error ? err.message : String(err)}`);
      prompt = '';
    }
  }

  if (!opts.cwd) {
    opts.cwd = process.cwd();
  }

  return {
    backend: opts.backend!,
    cwd: opts.cwd,
    prompt,
    sessionId: opts.sessionId,
    isFirstMessage: opts.isFirstMessage!,
    idleTimeout: opts.idleTimeout!,
    maxTimeout: opts.maxTimeout!,
    skipPermissions: opts.skipPermissions!,
    agent: opts.agent,
    mcpConfigPath: opts.mcpConfigPath,
    sessionDir: opts.sessionDir,
    recoverStaleSession: opts.recoverStaleSession!,
  };
}

async function main(): Promise<void> {
  let seq = 0;
  let errorEventEmitted = false;

  // Establish process group so the binary and spawned CLI form an isolated group.
  // This allows clean shutdown: if the binary is killed, the entire group is reaped.
  try {
    (process as any).setpgid?.(0, 0);
  } catch {
    // setpgid may fail on some platforms or shells; continue gracefully.
  }

  try {
    const execOpts = parseArgs(process.argv);

    // Create session manager if session-dir is provided
    const sessionManager = execOpts.sessionDir
      ? new SessionManager({
          persistPath: resolve(execOpts.sessionDir, 'sessions.json'),
        })
      : null;

    // Create process options for CliProcess.run()
    const processOpts: ProcessOptions = {
      cwd: execOpts.cwd,
      prompt: execOpts.prompt,
      agent: execOpts.agent,
      skipPermissions: execOpts.skipPermissions,
      mcpConfigPath: execOpts.mcpConfigPath,
      sessionId: execOpts.sessionId,
      isFirstMessage: execOpts.isFirstMessage,
      idleTimeout: execOpts.idleTimeout,
      maxTimeout: execOpts.maxTimeout,
    };

    const proc = new CliProcess(execOpts.backend);
    const eventGenerator = execOpts.recoverStaleSession && sessionManager
      ? runWithRecovery(proc, sessionManager, execOpts.sessionId || 'default', processOpts)
      : proc.run(processOpts);

    for await (const event of eventGenerator) {
      // Ensure seq is monotonically increasing
      seq = Math.max(seq + 1, event.seq);

      // Track if an error event was emitted for exit code determination
      if (event.type === 'error') {
        errorEventEmitted = true;
      }

      // Add version field to the event and output as NDJSON
      const wireEvent = {
        v: 1,
        ...event,
        seq,
      };

      // Output as NDJSON line
      console.log(JSON.stringify(wireEvent));

      // Record session ID if this is a done event
      if (event.type === 'done' && sessionManager && event.sessionId) {
        sessionManager.recordCliSessionId(execOpts.sessionId || 'default', event.sessionId);
      }
    }

    // Exit with code 1 if an error event was emitted, 0 for clean completion
    process.exit(errorEventEmitted ? 1 : 0);
  } catch (err) {
    // Log the error to stderr for diagnostics
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Binary error: ${errorMsg}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }

    // Handle unexpected errors
    const errorEvent = {
      v: 1,
      seq: seq + 1,
      timestamp: Date.now(),
      type: 'error',
      code: 'internal_error',
      detail: errorMsg,
    } satisfies ClaudeEvent;

    console.log(JSON.stringify(errorEvent));
    process.exit(3);
  }
}


main().catch(err => {
  // Log error information before exiting with code 2
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error in main: ${errorMsg}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(2);
});
