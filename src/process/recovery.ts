import type { ClaudeEvent } from '../events/types.js';
import type { ProcessOptions } from './types.js';
import type { CliProcess } from './CliProcess.js';
import type { SessionManager } from '../sessions/SessionManager.js';

/**
 * Wraps proc.run() with automatic stale-session recovery.
 *
 * On stale_session: clears the session key and retries once with a fresh
 * start (sessionId: undefined, isFirstMessage: true). All other events
 * are yielded to the caller unchanged.
 *
 * If the retry itself returns stale_session, that error is yielded and
 * iteration stops — something is wrong beyond a simple cache miss.
 */
export async function* runWithRecovery(
  proc: CliProcess,
  sessions: SessionManager,
  key: string,
  opts: ProcessOptions,
): AsyncGenerator<ClaudeEvent> {
  let recovered = false;
  let runOpts = opts;

  outer: while (true) {
    for await (const event of proc.run(runOpts)) {
      if (event.type === 'error' && event.code === 'stale_session' && !recovered) {
        sessions.clearSession(key);
        recovered = true;
        runOpts = { ...opts, sessionId: undefined, isFirstMessage: true };
        continue outer;
      }
      yield event;
    }
    break;
  }
}
