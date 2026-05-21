import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOOKS_DIR = join(homedir(), '.agent-bridge', 'tmp', 'hooks');

/**
 * Generate a temporary Claude settings file with a SessionStart hook
 * that POSTs session data to our hook server.
 */
export function generateHookSettings(port: number): string {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const filepath = join(HOOKS_DIR, `hook-${process.pid}.json`);

  // Inline hook command: read stdin (session data JSON), POST to our server.
  // Using node -e avoids needing an external script file.
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
