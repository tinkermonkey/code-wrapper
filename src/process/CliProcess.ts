import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ClaudeEvent, DistributiveOmit, ErrorEvent, ProgressEvent, ReadyEvent } from '../events/types.js';
import { parseCliLine, createCopilotAcpParser, createGeminiStreamParser, createCursorStreamParser } from '../events/EventParser.js';
import type { CliBackend, ProcessOptions } from './types.js';

const RATE_LIMIT_RE =
  /hit\s+(?:your\s+)?limit.*?resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;
const STALE_SESSION_RE = /conversation\s+not\s+found|no\s+conversation/i;
const CURSOR_STALE_SESSION_RE = /chat\s+not\s+found|session\s+not\s+found|conversation\s+not\s+found|invalid\s+chat/i;

/**
 * Spawns an AI coding agent CLI (Claude Code, GitHub Copilot, or Google Gemini),
 * delivers a prompt, and yields a normalized stream of ClaudeEvents.
 *
 * Claude Code: prompt via stdin; stream-json output parsed into typed events.
 *
 * Copilot: ACP protocol (copilot --acp --stdio); NDJSON JSON-RPC over
 *   stdin/stdout; initialize → session/new → session/prompt handshake;
 *   stateful parser produced by createCopilotAcpParser() tracks sessionUuid.
 *   Resume uses the same handshake (plus a --resume=<uuid> CLI flag) — the
 *   persisted session is loaded by session/new, which hands back a NEW
 *   session UUID rather than reusing the old one.
 *
 * Google Gemini: prompt via stdin; NDJSON stream-json output parsed
 *   into typed events by createGeminiStreamParser(). Session resume via
 *   `--conversation <id>` CLI flag.
 *
 * The caller is responsible for routing events — this class has no opinion
 * on whether they go to a WebSocket, Redis, SSE response, or an in-process
 * queue.
 */
export class CliProcess {
  private activeProc: ChildProcess | null = null;

  constructor(private readonly backend: CliBackend = 'claude') {}

  private sendSignal(proc: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (proc.pid == null) return;
    try {
      // Send signal directly to the child process. Child shares the parent's
      // process group (spawned without detached flag), so an external signal to
      // the process group (e.g., `kill -9 -<pgid>`, shell job control, systemd
      // KillMode=control-group) will terminate the entire group. Note: a
      // SIGKILL targeting only the child PID (e.g., `kill -9 <pid>`) will not
      // reach the child's descendants; they become orphaned and are reparented
      // to init/PID 1.
      process.kill(proc.pid, signal);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ESRCH') {
        throw err;
      }
    }
  }

  private binaryName(): string {
    switch (this.backend) {
      case 'claude': return 'claude';
      case 'copilot': return 'copilot';
      case 'gemini': return 'gemini';
      case 'cursor': return 'agent';
      default: { const _: never = this.backend; throw new Error(`Unknown backend: ${this.backend}`); }
    }
  }

  /** Returns true if the backend binary is found in PATH and is the correct type */
  async isAvailable(): Promise<boolean> {
    const bin = this.binaryName();

    if (this.backend === 'cursor') {
      // For Cursor, `agent` is a generic binary name. Verify it's a Cursor agent
      // by checking that `agent --version` output identifies Cursor.
      // This guards against collisions with unrelated binaries named `agent`.
      const r = spawnSync('agent', ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
      if (r.status !== 0) return false;
      const output = (r.stdout ?? '') + (r.stderr ?? '');
      // Cursor's version output typically includes "Cursor" or "agent" (Cursor branded)
      // Look for patterns that distinguish Cursor from other tools
      return /cursor|Cursor/i.test(output);
    }

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

    // For Cursor backend, guard against ARG_MAX limits on command-line size.
    // The prompt is passed via -p flag, so a very large prompt could exceed
    // the system's argument limit (~128KB on Linux). Use a conservative threshold.
    if (this.backend === 'cursor') {
      const maxPromptSize = 32 * 1024; // 32 KB conservative threshold
      if (prompt.length > maxPromptSize) {
        yield {
          seq: 0, timestamp: Date.now(), type: 'error', code: 'parse_error',
          detail: `Prompt exceeds ${maxPromptSize} bytes (${prompt.length} bytes). Consider breaking the request into smaller parts.`,
        } satisfies ErrorEvent;
        return;
      }
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

    const spawnOpts: SpawnOptions = {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      env,
      // Intentionally omit detached: true so the child process shares the parent's
      // process group. This ensures that an external signal to the process group
      // (e.g., kill -9 -<pgid>, systemd KillMode=control-group) will terminate
      // both the binary and its children, achieving the safety requirement in Req 7.
      // Trade-off: SIGKILL sent to the child PID (kill -9 <pid>) will not reach
      // grandchildren (e.g., tool-execution subprocesses spawned by the CLI); they
      // become orphaned and are reparented to init/PID 1. For "process group" level
      // safety (the requirement), external signaling is sufficient.
    };

    const proc = spawn(
      this.binaryName(),
      args,
      spawnOpts,
    );

    this.activeProc = proc;

    // stdin is kept open until a DoneEvent is observed or the process exits —
    // closing it right after session/prompt cuts the CLI off before it can
    // emit session/update text chunks. See closeStdin() call sites below.
    let stdinClosed = false;
    const closeStdin = (): void => {
      if (stdinClosed) return;
      stdinClosed = true;
      try { proc.stdin!.end(); } catch { /* ignore EPIPE */ }
    };

    const acpWrite = (msg: object): void => {
      proc.stdin!.write(JSON.stringify(msg) + '\n');
    };

    switch (this.backend) {
      case 'copilot': {
        // ACP handshake over stdin/stdout. Copilot v1.0.68+ requires:
        //   - protocolVersion as integer (not string)
        //   - session/prompt.sessionId from the session/new ack
        //   - session/prompt.prompt as [{type:'text',text:...}] array
        // Real Copilot persists ACP sessions to disk under a UUID. Resuming does
        // NOT mean reusing that UUID directly in session/prompt — the CLI is
        // launched with --resume=<uuid> (see buildCopilotArgs), and a fresh
        // session/new call loads the persisted context and hands back a NEW
        // session UUID. So new and resumed sessions send the identical
        // initialize + session/new sequence here; session/prompt is sent
        // reactively from the consume loop below once the ReadyEvent (sessionId
        // from the session/new ack) is parsed from stdout.
        acpWrite({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, capabilities: {} } });
        acpWrite({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
        // stdin stays open — session/prompt is sent from the consume loop below
        break;
      }
      case 'gemini': {
        // Google Gemini receives the prompt via stdin, like Claude.
        // This keeps prompts with sensitive information (API keys, PII) out of the
        // process argument list (visible via ps/proc), mitigating exposure risks.
        proc.stdin!.write(prompt);
        closeStdin();
        break;
      }
      case 'claude': {
        // Claude receives the prompt via stdin.
        proc.stdin!.write(prompt);
        closeStdin();
        break;
      }
      case 'cursor': {
        // Cursor receives the prompt via -p CLI flag (buildCursorArgs), not via stdin.
        // Close stdin immediately since there's nothing to write.
        closeStdin();
        break;
      }
      default: {
        const _: never = this.backend;
        throw new Error(`Unknown backend: ${_}`);
      }
    }

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

    // The child has terminated (though its stdio streams may not have fully
    // closed yet) — close stdin now if a DoneEvent never arrived. Node's
    // 'close' event above waits for all stdio streams to close, and our own
    // writable stdin stream cannot close until .end() is called on it — so
    // this must run on 'exit', not after awaiting exitPromise, or a process
    // that exits without ever emitting a DoneEvent would deadlock forever.
    proc.on('exit', () => closeStdin());

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

    pushEvent({
      seq: seq++, timestamp: Date.now(), type: 'progress', elapsed: 0,
    } satisfies ProgressEvent);

    let spawnError: ErrorEvent | null = null;
    proc.on('error', (err: Error) => {
      spawnError = {
        seq: seq++, timestamp: Date.now(), type: 'error', code: 'spawn_error',
        detail: err.message,
      };
      pushEvent(null);
    });

    const parseLine = (() => {
      switch (this.backend) {
        case 'copilot': return createCopilotAcpParser();
        case 'gemini': return createGeminiStreamParser();
        case 'cursor': return createCursorStreamParser();
        case 'claude': return parseCliLine;
        default: {
          const _: never = this.backend;
          throw new Error(`Unknown backend: ${_}`);
        }
      }
    })();

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

    const abortHandler = (): void => {
      if (killedBy) return;
      killedBy = 'aborted';
      this.sendSignal(proc, 'SIGTERM');
      sigkillTimer = setTimeout(() => this.sendSignal(proc, 'SIGKILL'), _sigkillDelayMs);
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler);
      // Re-check after registering: guards against runtimes (e.g. Worker
      // threads) where abort can be dispatched across thread boundaries
      // between the pre-flight check and addEventListener.
      if (signal.aborted) abortHandler();
    }

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (killedBy) return;
      pushEvent({
        seq: seq++, timestamp: now, type: 'progress',
        elapsed: Math.floor((now - startedAt) / 1_000),
      } satisfies ProgressEvent);
      if (now - lastOutputAt > idleTimeout * 1_000) {
        killedBy = 'idle';
        this.sendSignal(proc, 'SIGTERM');
        sigkillTimer = setTimeout(() => this.sendSignal(proc, 'SIGKILL'), _sigkillDelayMs);
      } else if (now - startedAt > maxTimeout * 1_000) {
        killedBy = 'max';
        this.sendSignal(proc, 'SIGTERM');
        sigkillTimer = setTimeout(() => this.sendSignal(proc, 'SIGKILL'), _sigkillDelayMs);
      }
    }, _watchdogIntervalMs);

    const mk = (e: DistributiveOmit<ClaudeEvent, 'seq' | 'timestamp'>): ClaudeEvent =>
      ({ ...e, seq: seq++, timestamp: Date.now() } as ClaudeEvent);

    // For Copilot (new or resumed): session/prompt is sent reactively once the
    // ReadyEvent (sessionId from the session/new ack) arrives. For Claude,
    // the prompt was already written and stdin closed before the consume loop.
    let acpSessionPromptSent = this.backend !== 'copilot';

    try {
      // Consume from the shared queue until readline closes (null sentinel)
      while (true) {
        if (queue.length === 0) await waitForEvent();
        const item = queue.shift()!;
        if (item === null) break;
        if (!acpSessionPromptSent && item.type === 'ready') {
          acpSessionPromptSent = true;
          acpWrite({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
            sessionId: (item as ReadyEvent).sessionId,
            prompt: [{ type: 'text', text: prompt }],
          } });
          // stdin stays open — closed only once a DoneEvent is observed (or
          // the process exits), so streamed text chunks aren't cut off.
        }
        if (item.type === 'done') {
          closeStdin();
        }
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
      //
      // Cursor caveat: CURSOR_STALE_SESSION_RE is checked only for 'cursor' backend.

      if (spawnError !== null) {
        yield spawnError;
        return;
      }

      // Check for Cursor-specific stale session errors
      if (this.backend === 'cursor' && CURSOR_STALE_SESSION_RE.test(stderrBuf)) {
        yield mk({
          type: 'error',
          code: 'stale_session',
          detail: 'Cursor session not found — call clearSession() and retry without sessionId',
        });
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
        code: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearInterval(watchdog);
      if (sigkillTimer !== null) clearTimeout(sigkillTimer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      // Safety net: close stdin if a DoneEvent was never observed (process
      // errored, was aborted, timed out, or exited without emitting one).
      closeStdin();
      this.activeProc = null;
    }
  }

  /** SIGTERM the active subprocess, escalating to SIGKILL after gracePeriodMs */
  async kill(gracePeriodMs = 3_000): Promise<void> {
    const proc = this.activeProc;
    if (!proc || proc.pid == null) return;

    this.sendSignal(proc, 'SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.sendSignal(proc, 'SIGKILL'); resolve(); }, gracePeriodMs);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
    });
    this.activeProc = null;
  }

  private buildArgs(options: ProcessOptions): string[] {
    switch (this.backend) {
      case 'copilot': {
        return this.buildCopilotArgs(options);
      }
      case 'gemini': {
        return this.buildGeminiArgs(options);
      }
      case 'cursor': {
        return this.buildCursorArgs(options);
      }
      case 'claude': {
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
      default: {
        const _: never = this.backend;
        throw new Error(`Unknown backend: ${_}`);
      }
    }
  }

  /**
   * Build args for the GitHub Copilot CLI (`copilot` npm package) in ACP mode.
   *
   * Invocation: copilot --acp --stdio
   * The prompt is NOT passed as a flag — it is sent as a session/prompt
   * NDJSON message over stdin in run() after the initialize/session/new handshake.
   *
   * Session resume: --resume=<uuid> (the UUID comes from the ReadyEvent.sessionId
   * produced by the session/new response on the first message). The CLI loads
   * the persisted session state itself; the ACP session/new call that follows
   * still returns a NEW session UUID, distinct from the one passed here.
   */
  private buildCopilotArgs(options: ProcessOptions): string[] {
    const { sessionId, isFirstMessage = true, skipPermissions = false, agent } = options;
    const args = ['--acp', '--stdio'];
    if (skipPermissions) args.push('--allow-all-tools');
    if (agent) args.push('--agent', agent);
    if (sessionId && !isFirstMessage) args.push(`--resume=${sessionId}`);
    return args;
  }

  /**
   * Build args for the Google Gemini CLI (`gemini`).
   *
   * Invocation: gemini --output-format stream-json
   * The prompt is passed via stdin, not as a flag, to avoid exposure in process listings.
   * This keeps sensitive information (API keys, PII, credentials) out of ps/proc.
   *
   * Session resume: --conversation <id> (when isFirstMessage is false)
   * New session: no resume flag (when isFirstMessage is true or not provided)
   *
   * Note: mcpConfigPath is not passed to Gemini as it uses its own MCP discovery.
   */
  private buildGeminiArgs(options: ProcessOptions): string[] {
    const {
      skipPermissions = false,
      sessionId,
      isFirstMessage = true,
      agent,
    } = options;

    const args = ['--output-format', 'stream-json'];

    if (skipPermissions) args.push('--dangerously-skip-permissions');

    if (sessionId && !isFirstMessage) {
      args.push('--conversation', sessionId);
    }

    if (agent) args.unshift('--agent', agent);

    return args;
  }

  /**
   * Build args for the Cursor CLI (`agent`).
   *
   * Invocation: agent -p <prompt> --output-format stream-json [--workspace cwd] [--resume chatId] [--force] [--agent agent]
   * The prompt is passed as the -p flag, not via stdin.
   *
   * Session resume: --resume <chatId> (when isFirstMessage is false)
   */
  private buildCursorArgs(options: ProcessOptions): string[] {
    const {
      prompt,
      skipPermissions = false,
      sessionId,
      isFirstMessage = true,
      agent,
      cwd,
    } = options;

    const args = ['-p', prompt, '--output-format', 'stream-json'];

    if (cwd !== undefined && cwd !== process.cwd()) {
      args.push('--workspace', cwd);
    }

    if (skipPermissions) {
      args.push('--force');
    }

    if (sessionId && !isFirstMessage) {
      args.push('--resume', sessionId);
    }

    if (agent) {
      args.push('--agent', agent);
    }

    return args;
  }
}
