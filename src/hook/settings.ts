import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const GLOBAL_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const HOOKS_DIR = join(homedir(), '.agent-bridge', 'tmp', 'hooks');

function hookCommand(port: number, path: string): string {
  return `curl -s -X POST http://127.0.0.1:${port}${path} -d @- || true`;
}

/**
 * Install hooks into ~/.claude/settings.local.json so all `claude` invocations
 * notify the daemon. Merges with existing settings.
 */
export function installGlobalHooks(port: number): void {
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(GLOBAL_SETTINGS_PATH)) {
      existing = JSON.parse(readFileSync(GLOBAL_SETTINGS_PATH, 'utf8'));
    }
  } catch {}

  const hooks = (existing.hooks ?? {}) as Record<string, unknown[]>;

  const bridgeHook = (cmd: string) => ({
    matcher: '*',
    hooks: [{ type: 'command', command: cmd }],
  });

  hooks.SessionStart = filterNonBridgeHooks(hooks.SessionStart);
  hooks.SessionStart.push(bridgeHook(hookCommand(port, '/hook/session-start')));

  hooks.Stop = filterNonBridgeHooks(hooks.Stop);
  hooks.Stop.push(bridgeHook(hookCommand(port, '/hook/stop')));

  existing.hooks = hooks;

  mkdirSync(dirname(GLOBAL_SETTINGS_PATH), { recursive: true });
  writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(existing, null, 2));
}

/**
 * Remove agent-bridge hooks from ~/.claude/settings.local.json.
 */
export function uninstallGlobalHooks(): void {
  try {
    if (!existsSync(GLOBAL_SETTINGS_PATH)) return;
    const existing = JSON.parse(readFileSync(GLOBAL_SETTINGS_PATH, 'utf8'));
    const hooks = existing.hooks as Record<string, unknown[]> | undefined;
    if (!hooks) return;

    if (hooks.SessionStart) hooks.SessionStart = filterNonBridgeHooks(hooks.SessionStart);
    if (hooks.Stop) hooks.Stop = filterNonBridgeHooks(hooks.Stop);

    for (const key of Object.keys(hooks)) {
      if (Array.isArray(hooks[key]) && hooks[key].length === 0) delete hooks[key];
    }
    if (Object.keys(hooks).length === 0) delete existing.hooks;

    writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(existing, null, 2));
  } catch {}
}

function isBridgeHook(h: any): boolean {
  const innerHooks = h?.hooks;
  if (!Array.isArray(innerHooks)) return false;
  return innerHooks.some((ih: any) => {
    const cmd = ih?.command;
    return typeof cmd === 'string' && (cmd.includes('/hook/session-start') || cmd.includes('/hook/stop'));
  });
}

function filterNonBridgeHooks(arr: unknown[] | undefined): unknown[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((h) => !isBridgeHook(h));
}

/**
 * Generate a temporary per-process hook settings file (legacy, for `claude --settings`).
 */
export function generateHookSettings(port: number): string {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const filepath = join(HOOKS_DIR, `hook-${process.pid}.json`);

  const cmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const http=require('http');const r=http.request({hostname:'127.0.0.1',port:${port},path:'/hook/session-start',method:'POST'},()=>{});r.end(d)})"`;

  const settings = {
    hooks: {
      SessionStart: [{
        matcher: '*',
        hooks: [{ type: 'command', command: cmd }],
      }],
    },
  };

  writeFileSync(filepath, JSON.stringify(settings));
  return filepath;
}

export function cleanupHookSettings(filepath: string): void {
  try { if (existsSync(filepath)) unlinkSync(filepath); } catch {}
}
