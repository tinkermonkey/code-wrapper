import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ClaudeEvent, ErrorEvent, ProgressEvent } from '../events/types.js';
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
   * process exits (cleanly, by timeout, by abort, or by error).
   *
   * A ProgressEvent with elapsed=0 is yielded immediately on spawn. The
   * watchdog emits further ProgressEvents every 5 seconds, giving callers a
   * heartbeat even during long tool calls with no text output.
   */
  async *run(options: ProcessOptions): AsyncGenerator<ClaudeEvent> {
    const {
      cwd,
      prompt,
      idleTimeout = 300,
      maxTimeout = 3600,
      signal,
    } = options;

    // Reject immediately if the signal is already cancelled — no subprocess
    // is spawned.
    if (signal?.aborted) {
      yield {
        seq: 0, timestamp: Date.now(), type: 'error', code: 'aborted',
        detail: 'AbortSignal was already aborted before process started',
      } satisfies ErrorEvent;
      return;
    }

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
    let killedBy: 'idle' | 'max' | 'aborted' | null = null;
    const startedAt = Date.now();
    let lastOutputAt = Date.now();

    // exitCode is set when the process fully closes (stdout + stderr drained).
    let exitCode: number | null = null;
    const exitPromise = new Promise<void>(resolve => {
      proc.on('close', code => { exitCode = code; resolve(); });
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    // Shared async queue fed by readline (stdout lines) and the watchdog
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

    // Immediate heartbeat so callers receive a progress event at process start
    // without waiting for the first watchdog tick (5 seconds).
    pushEvent({
      seq: seq++, timestamp: Date.now(), type: 'progress', elapsed: 0,
    } satisfies ProgressEvent);

    // Spawn errors (ENOENT, EACCES, etc.) arrive asynchronously via 'error'.
    // Save the event so it can be yielded after the consume loop drains,
    // regardless of whether proc.on('error') or rl.on('close') fires first.
    let spawnError: ErrorEvent | null = null;
    proc.on('error', (err: Error) => {
      spawnError = {
        seq: seq++, timestamp: Date.now(), type: 'error', code: 'spawn_error',
        detail: err.message,
      };
      pushEvent(null);
    });

    const rl = createInterface({ input: proc.stdout!, terminal: false, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      lastOutputAt = Date.now();
      for (const event of parseCliLine(line, seq)) {
        seq = event.seq + 1;
        pushEvent(event);
      }
    });
    rl.on('close', () => pushEvent(null));

    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    // AbortSignal: kill the process and mark the reason so the correct
    // ErrorEvent is yielded after the consume loop drains.
    const abortHandler = (): void => {
      if (killedBy) return;
      killedBy = 'aborted';
      proc.kill('SIGTERM');
      sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), 3_000);
    };
    if (signal) signal.addEventListener('abort', abortHandler);

    // Watchdog: emit ProgressEvent each tick, then enforce timeouts.
    // On timeout: SIGTERM first, SIGKILL after 3s if still alive.
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
        sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), 3_000);
      } else if (now - startedAt > maxTimeout * 1_000) {
        killedBy = 'max';
        proc.kill('SIGTERM');
        sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), 3_000);
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

      // Exit precedence (highest to lowest):
      //   spawn_error > stale_session > rate_limit > aborted
      //   > idle_timeout > max_timeout > nonzero_exit > clean

      if (spawnError !== null) {
        yield spawnError;
        return;
      }

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

      if (killedBy === 'aborted') {
        yield mk({ type: 'error', code: 'aborted', detail: 'Run cancelled via AbortSignal' });
      } else if (killedBy === 'idle') {
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
      // Defensive catch — the consume loop and exit checks should not throw.
      yield mk({
        type: 'error',
        code: 'spawn_error',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearInterval(watchdog);
      if (sigkillTimer !== null) clearTimeout(sigkillTimer);
      if (signal) signal.removeEventListener('abort', abortHandler);
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
