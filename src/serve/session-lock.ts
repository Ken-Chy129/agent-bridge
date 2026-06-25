import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOCK_DIR = join(homedir(), '.agent-bridge', 'locks');

function lockPath(sessionId: string): string {
  return join(LOCK_DIR, `${sessionId}.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire an exclusive bridge lock for a session, so two agent-bridge
 * processes (e.g. a manual `relay` and a running `serve`) never mirror the same
 * session to Feishu at once — which would double-post every message.
 *
 * Returns null on success, or the PID of the live holder if already locked.
 * A lock left by a dead process is treated as stale and reclaimed.
 */
export function acquireSessionLock(sessionId: string): number | null {
  mkdirSync(LOCK_DIR, { recursive: true });
  const path = lockPath(sessionId);
  if (existsSync(path)) {
    const held = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (Number.isFinite(held) && held !== process.pid && isPidAlive(held)) {
      return held;
    }
    // stale (dead holder) or our own — fall through and (re)claim it
  }
  writeFileSync(path, String(process.pid));
  return null;
}

/** Release a session lock previously acquired by this process. */
export function releaseSessionLock(sessionId: string): void {
  const path = lockPath(sessionId);
  try {
    if (!existsSync(path)) return;
    const held = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (held === process.pid) rmSync(path);
  } catch {
    // ignore — a missing/corrupt lock is not worth crashing over
  }
}
