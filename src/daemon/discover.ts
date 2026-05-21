import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { LocalSession } from './types';

const CC_SESSIONS_DIR = resolve(homedir(), '.claude', 'sessions');

/**
 * Scan ~/.claude/sessions/*.json to discover running Claude Code instances.
 * Each file is written by a live CC process and contains pid, sessionId, cwd, status.
 */
export function discoverCCSessions(): LocalSession[] {
  let files: string[];
  try {
    files = readdirSync(CC_SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const sessions: LocalSession[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(resolve(CC_SESSIONS_DIR, file), 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      sessions.push({
        pid: data.pid as number,
        sessionId: data.sessionId as string,
        cwd: data.cwd as string,
        status: (data.status as string) ?? 'unknown',
        startedAt: data.startedAt as number,
        version: (data.version as string) ?? '',
      });
    } catch {
      // corrupt or locked file, skip
    }
  }
  return sessions;
}
