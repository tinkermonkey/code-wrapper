import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ClaudeEvent, ProgressEvent } from '../events/types.js';
import { parseCliLine } from '../events/EventParser.js';
import type { CliBackend, ProcessOptions } from './types.js';

const RATE_LIMIT_RE =
  /hit\s+(?:your\s+)?limit.*?resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;
const STALE_SESSION_RE = /no conversation found with session id/i;

/**
 * Spawns an AI coding agent CLI (Claude Code or GitHub Copilot), delivers a
 * prompt via stdin, and yields a normalized stream of ClaudeEvents.
 *
 * The caller is responsible for routing events — this class has no opinion
 * on whether they go to a WebSocket, Redis, SSE response, or an in-process
 * queue.
 */
export class CliProcess {
  private activeProc: ChildProcess | null = null;

  constructor(private readonly backend: CliBackend = 'claude') {}

  /** Returns true if the backend binary is found in PATH */
  async isAvailable(): Promise<boolean> {
    const bin = this.backend === 'claude' ? 'claude' : 'gh';
    const r = spawnSync('which', [bin], { stdio: 'pipe' });
    return r.status === 0;
  }

  /**
   * Spawn the CLI, deliver the prompt, and yield normalized events until the
   * process exits (cleanly, by timeout, or by error).
   *
   * ProgressEvents are emitted by the watchdog every 5 seconds regardless of
   * stdout activity, giving callers a heartbeat during long tool calls.
   */
  async *run(options: ProcessOptions): AsyncGenerator<ClaudeEvent> {
    const {
      cwd,
      prompt,
      idleTimeout = 300,
      maxTimeout = 3600,
    } = options;

    const args = this.buildArgs(options);

    // Remove CLAUDECODE so nested invocations are not blocked by Claude's
    // protection against running inside an existing Claude Code session.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['CLAUDECODE'];

    const proc = spawn(
      this.backend === 'claude' ? 'claude' : 'gh',
      args,
      { cwd, stdio: ['pipe', 'pipe', 'pipe'], env },
    );

    this.activeProc = proc;
    proc.stdin!.write(prompt);
    proc.stdin!.end();

    let seq = 0;
    let stderrBuf = '';
    let killedBy: 'idle' | 'max' | null = null;
    const startedAt = Date.now();
    let lastOutputAt = Date.now();

    // exitCode is set when the process fully closes (stdout + stderr drained).
    // exitPromise lets us await that moment after the queue drains.
    let exitCode: number | null = null;
    const exitPromise = new Promise<void>(resolve => {
      proc.on('close', code => { exitCode = code; resolve(); });
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    // Shared async queue fed by both readline (stdout lines) and the watchdog
    // (ProgressEvents). null is the sentinel that signals readline has closed.
    const queue: (ClaudeEvent | null)[] = [];
    let queueNotify: (() => void) | null = null;

    const pushEvent = (e: ClaudeEvent | null): void => {
      queue.push(e);
      queueNotify?.();
      queueNotify = null;
    };

    const waitForEvent = (): Promise<void> =>
      new Promise<void>(r => { queueNotify = r; });

    // Wire readline output into the queue
    const rl = createInterface({ input: proc.stdout!, terminal: false, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      lastOutputAt = Date.now();
      for (const event of parseCliLine(line, seq)) {
        seq = event.seq + 1;
        pushEvent(event);
      }
    });
    rl.on('close', () => pushEvent(null));

    // Watchdog: emit a ProgressEvent every tick, then enforce timeouts.
    // Runs until clearInterval in the finally block.
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (killedBy) return;
      pushEvent({
        seq: seq++, timestamp: now, type: 'progress',
        elapsed: Math.floor((now - startedAt) / 1_000),
      } satisfies ProgressEvent);
      if (now - lastOutputAt > idleTimeout * 1_000) {
        killedBy = 'idle';
        proc.kill('SIGTERM');
      } else if (now - startedAt > maxTimeout * 1_000) {
        killedBy = 'max';
        proc.kill('SIGTERM');
      }
    }, 5_000);

    const mk = (e: Omit<ClaudeEvent, 'seq' | 'timestamp'>): ClaudeEvent =>
      ({ ...e, seq: seq++, timestamp: Date.now() } as ClaudeEvent);

    try {
      // Consume from the shared queue until readline closes (null sentinel)
      while (true) {
        if (queue.length === 0) await waitForEvent();
        const item = queue.shift()!;
        if (item === null) break;
        yield item;
      }

      // Readline ended (stdout closed). Wait for the process to fully exit so
      // we have the exit code and complete stderr before deciding what to surface.
      await exitPromise;

      // Specific stderr conditions take precedence over the generic exit code.
      if (STALE_SESSION_RE.test(stderrBuf)) {
        yield mk({
          type: 'error',
          code: 'stale_session',
          detail: 'CLI reported session ID not found — call clearSession() and retry without sessionId',
        });
        return;
      }

      if (RATE_LIMIT_RE.test(stderrBuf)) {
        const match = stderrBuf.match(RATE_LIMIT_RE);
        yield mk({ type: 'error', code: 'rate_limit', detail: match?.[0] ?? 'Rate limit hit' });
        return;
      }

      if (killedBy === 'idle') {
        const elapsed = Math.floor((Date.now() - startedAt) / 1_000);
        yield mk({
          type: 'error',
          code: 'idle_timeout',
          detail: `No output for ${idleTimeout}s (${elapsed}s total)`,
        });
      } else if (killedBy === 'max') {
        yield mk({
          type: 'error',
          code: 'max_timeout',
          detail: `Exceeded max runtime of ${maxTimeout}s`,
        });
      } else {
        const code = exitCode;
        if (code !== null && code !== 0) {
          yield mk({
            type: 'error',
            code: 'nonzero_exit',
            detail: `Process exited with code ${code}`,
            exitCode: code,
          });
        }
      }
    } catch (err) {
      yield mk({
        type: 'error',
        code: 'spawn_error',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearInterval(watchdog);
      this.activeProc = null;
    }
  }

  /** SIGTERM the active subprocess, escalating to SIGKILL after gracePeriodMs */
  async kill(gracePeriodMs = 3_000): Promise<void> {
    const proc = this.activeProc;
    if (!proc) return;
    proc.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, gracePeriodMs);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
    });
    this.activeProc = null;
  }

  private buildArgs(options: ProcessOptions): string[] {
    if (this.backend === 'copilot') {
      throw new Error('Copilot backend is not yet implemented');
    }

    const {
      skipPermissions = false,
      mcpConfigPath,
      sessionId,
      isFirstMessage = true,
      agent,
    } = options;

    const args = ['--print', '--verbose', '--output-format', 'stream-json'];

    if (skipPermissions) args.push('--permission-mode', 'bypassPermissions');
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

    if (sessionId) {
      // --session-id: start a new session with a known, traceable ID
      // --resume:     continue an existing session
      args.push(isFirstMessage ? '--session-id' : '--resume', sessionId);
    }

    // --agent must come before the other args
    if (agent) args.unshift('--agent', agent);

    return args;
  }
}
