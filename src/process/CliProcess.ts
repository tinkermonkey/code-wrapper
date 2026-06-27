import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ClaudeEvent, ErrorEvent, ProgressEvent } from '../events/types.js';
import { parseCliLine, createCopilotAcpParser } from '../events/EventParser.js';
import type { CliBackend, ProcessOptions } from './types.js';

const RATE_LIMIT_RE =
  /hit\s+(?:your\s+)?limit.*?resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;
const STALE_SESSION_RE = /no conversation found with session id/i;

/**
 * Spawns an AI coding agent CLI (Claude Code or GitHub Copilot), delivers a
 * prompt, and yields a normalized stream of ClaudeEvents.
 *
 * Claude Code: prompt via stdin; stream-json output parsed into typed events.
 * Copilot: ACP protocol (copilot --acp --stdio); NDJSON JSON-RPC over
 *   stdin/stdout; initialize → session/new → session/prompt handshake;
 *   stateful parser produced by createCopilotAcpParser() tracks sessionUuid.
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
    const bin = this.backend === 'claude' ? 'claude' : 'copilot';
    const r = spawnSync('which', [bin], { stdio: 'pipe' });
    return r.status === 0;
  }

  /**
   * Spawn the CLI, deliver the prompt, and yield normalized events until the
   * process exits (cleanly, by timeout, by abort, or by error).
   *
   * A ProgressEvent with elapsed=0 is yielded immediately on spawn. The
   * watchdog emits further ProgressEvents every _watchdogIntervalMs (default
   * 5 s), giving callers a heartbeat even during long tool calls.
   */
  async *run(options: ProcessOptions): AsyncGenerator<ClaudeEvent> {
    const {
      cwd,
      prompt,
      idleTimeout = 300,
      maxTimeout = 3600,
      signal,
      _watchdogIntervalMs = 5_000,
      _sigkillDelayMs = 3_000,
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

    // Prefer OAuth token over API key; pass only one auth credential to the
    // subprocess so the CLI auth path is unambiguous.
    if (env['CLAUDE_CODE_OAUTH_TOKEN']) {
      delete env['ANTHROPIC_API_KEY'];
    } else {
      delete env['CLAUDE_CODE_OAUTH_TOKEN'];
    }

    const proc = spawn(
      this.backend === 'claude' ? 'claude' : 'copilot',
      args,
      { cwd, stdio: ['pipe', 'pipe', 'pipe'], env },
    );

    this.activeProc = proc;

    if (this.backend === 'copilot') {
      // ACP handshake: write NDJSON JSON-RPC messages to stdin then close.
      // The server responds to each over stdout; the readline handler below
      // parses them via createCopilotAcpParser().
      const acpWrite = (msg: object): void => {
        proc.stdin!.write(JSON.stringify(msg) + '\n');
      };
      acpWrite({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-01', capabilities: {} } });
      acpWrite({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd } });
      acpWrite({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt } });
    } else {
      proc.stdin!.write(prompt);
    }
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
    // without waiting for the first watchdog tick.
    pushEvent({
      seq: seq++, timestamp: Date.now(), type: 'progress', elapsed: 0,
    } satisfies ProgressEvent);

    // Spawn errors (ENOENT, EACCES, etc.) arrive asynchronously via 'error'.
    // Save the event so it can be yielded after the consume loop drains.
    let spawnError: ErrorEvent | null = null;
    proc.on('error', (err: Error) => {
      spawnError = {
        seq: seq++, timestamp: Date.now(), type: 'error', code: 'spawn_error',
        detail: err.message,
      };
      pushEvent(null);
    });

    // Copilot: stateful ACP parser tracks sessionUuid across lines.
    // Claude: stateless parseCliLine.
    const parseLine = this.backend === 'copilot' ? createCopilotAcpParser() : parseCliLine;

    const rl = createInterface({ input: proc.stdout!, terminal: false, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      lastOutputAt = Date.now();
      for (const event of parseLine(line, seq)) {
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
      sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), _sigkillDelayMs);
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler);
      // Re-check after registering: guards against runtimes (e.g. Worker
      // threads) where abort can be dispatched across thread boundaries
      // between the pre-flight check and addEventListener.
      if (signal.aborted) abortHandler();
    }

    // Watchdog: emit ProgressEvent each tick, then enforce timeouts.
    // On timeout: SIGTERM first, SIGKILL after _sigkillDelayMs if still alive.
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
        sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), _sigkillDelayMs);
      } else if (now - startedAt > maxTimeout * 1_000) {
        killedBy = 'max';
        proc.kill('SIGTERM');
        sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), _sigkillDelayMs);
      }
    }, _watchdogIntervalMs);

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
      //
      // ACP caveat: STALE_SESSION_RE and RATE_LIMIT_RE scan stderr only.
      // Copilot (ACP mode) surfaces stale sessions and rate limits as JSON-RPC
      // error responses on stdout — they arrive as ErrorEvent { code: 'cli_error' }.
      // runWithRecovery() will not auto-retry them; callers must inspect detail.

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
      return this.buildCopilotArgs(options);
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
      args.push(isFirstMessage ? '--session-id' : '--resume', sessionId);
    }

    if (agent) args.unshift('--agent', agent);

    return args;
  }

  /**
   * Build args for the GitHub Copilot CLI (`copilot` npm package) in ACP mode.
   *
   * Invocation: copilot --acp --stdio
   * The prompt is NOT passed as a flag — it is sent as a session/prompt
   * NDJSON message over stdin in run() after the initialize/session/new handshake.
   *
   * Session resume: --resume=<uuid> (the UUID comes from the ReadyEvent.sessionId
   * produced by the session/new response on the first message).
   */
  private buildCopilotArgs(options: ProcessOptions): string[] {
    const { sessionId, isFirstMessage = true, skipPermissions = false, agent } = options;
    const args = ['--acp', '--stdio'];
    if (skipPermissions) args.push('--allow-all-tools');
    if (agent) args.push('--agent', agent);
    if (sessionId && !isFirstMessage) args.push(`--resume=${sessionId}`);
    return args;
  }
}
