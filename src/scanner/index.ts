import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startFileWatcher } from './watcher';

export interface ScannedMessage {
  type: 'user' | 'assistant' | 'summary' | 'system';
  uuid: string;
  raw: Record<string, unknown>;
  /** For assistant messages: 'end_turn' means CC is done, 'tool_use' means more work coming. */
  stopReason?: string;
  /** Pre-parsed message.content (string or content-block array). */
  content?: unknown;
  /** Pre-parsed summary text (for type === 'summary'). */
  summaryText?: string;
}

const SKIP_TYPES = new Set(['file-history-snapshot', 'change', 'queue-operation', 'last-prompt', 'permission-mode']);

/**
 * Watch a CC session JSONL file for new messages.
 * Emits only NEW messages (skips ones already on disk at creation time).
 */
export function createSessionScanner(opts: {
  workingDirectory: string;
  onMessage: (msg: ScannedMessage) => void;
}) {
  const projectDir = ccProjectDir(opts.workingDirectory);
  const seen = new Set<string>();
  const offsets = new Map<string, number>();
  const watchers = new Map<string, () => void>();
  let currentSessionId: string | null = null;
  let interval: NodeJS.Timeout | null = null;

  function scan() {
    const sessionIds = [currentSessionId, ...watchers.keys()].filter(Boolean) as string[];
    for (const sid of new Set(sessionIds)) {
      const offset = offsets.get(sid) ?? 0;
      const { msgs, newOffset } = readJSONL(projectDir, sid, offset);
      offsets.set(sid, newOffset);
      for (const m of msgs) {
        const key = msgKey(m);
        if (seen.has(key)) continue;
        seen.add(key);
        opts.onMessage(m);
      }
      if (!watchers.has(sid)) {
        watchers.set(sid, startFileWatcher(join(projectDir, `${sid}.jsonl`), scan));
      }
    }
  }

  function markExistingAsRead(sessionId: string) {
    const { msgs, newOffset } = readJSONL(projectDir, sessionId, 0);
    offsets.set(sessionId, newOffset);
    for (const m of msgs) seen.add(msgKey(m));
  }

  return {
    /** Call when a session ID is discovered (from hook or session file). */
    setSession(sessionId: string) {
      if (sessionId === currentSessionId) return;
      currentSessionId = sessionId;
      scan();
    },
    /** Mark all current messages as already-read, then start watching. */
    initExisting(sessionId: string) {
      markExistingAsRead(sessionId);
      this.setSession(sessionId);
    },
    startPolling() {
      interval = setInterval(scan, 3000);
    },
    cleanup() {
      if (interval) clearInterval(interval);
      for (const stop of watchers.values()) stop();
      watchers.clear();
    },
  };
}

function ccProjectDir(cwd: string): string {
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

function readJSONL(projectDir: string, sessionId: string, fromOffset: number): { msgs: ScannedMessage[]; newOffset: number } {
  const file = join(projectDir, `${sessionId}.jsonl`);
  let size: number;
  try { size = statSync(file).size; } catch { return { msgs: [], newOffset: fromOffset }; }
  if (size <= fromOffset) return { msgs: [], newOffset: fromOffset };

  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - fromOffset);
    readSync(fd, buf, 0, buf.length, fromOffset);
    const chunk = buf.toString('utf8');

    const msgs: ScannedMessage[] = [];
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!obj.type || SKIP_TYPES.has(obj.type)) continue;
        if (!obj.uuid && obj.type !== 'summary') continue;
        const uuid = obj.uuid ?? `summary:${obj.leafUuid}`;
        if (['user', 'assistant', 'summary', 'system'].includes(obj.type)) {
          const stopReason = obj.type === 'assistant' ? obj.message?.stop_reason : undefined;
          const content = obj.message?.content;
          const summaryText = obj.type === 'summary' ? obj.summary : undefined;
          msgs.push({ type: obj.type, uuid, raw: obj, stopReason, content, summaryText });
        }
      } catch {}
    }
    return { msgs, newOffset: size };
  } finally {
    closeSync(fd);
  }
}

function msgKey(m: ScannedMessage): string {
  return `${m.type}:${m.uuid}`;
}
