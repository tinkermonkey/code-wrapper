#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliProcess } from '../process/CliProcess.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { runWithRecovery } from '../process/recovery.js';
import type { CliBackend, ProcessOptions } from '../process/types.js';

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
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read prompt from stdin: ${errorMsg}`);
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

  const execOpts = parseArgs(process.argv);

  const sessionManager = execOpts.sessionDir
    ? new SessionManager({
        persistPath: resolve(execOpts.sessionDir, 'sessions.json'),
      })
    : null;

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
    seq = Math.max(seq + 1, event.seq);

    if (event.type === 'error') {
      errorEventEmitted = true;
    }

    console.log(JSON.stringify({
      v: 1,
      ...event,
      seq,
    }));

    if (event.type === 'done' && sessionManager && event.sessionId) {
      sessionManager.recordCliSessionId(execOpts.sessionId || 'default', event.sessionId);
    }
  }

  process.exit(errorEventEmitted ? 1 : 0);
}

main().catch(err => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${errorMsg}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(2);
});
