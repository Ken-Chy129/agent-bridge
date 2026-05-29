import { createServer, type Server } from 'node:http';

export interface HookServerCallbacks {
  onSessionStart?: (sessionId: string, cwd: string) => void;
  onStop?: (sessionId: string) => void;
}

export async function startHookServer(
  callbacks: HookServerCallbacks,
): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}

      if (req.url === '/hook/session-start') {
        const sid = (data.session_id ?? data.sessionId) as string | undefined;
        const cwd = (data.cwd ?? '') as string;
        if (sid) callbacks.onSessionStart?.(sid, cwd);
        res.writeHead(200).end('ok');
        return;
      }

      if (req.url === '/hook/stop') {
        const sid = (data.session_id ?? data.sessionId) as string | undefined;
        if (sid) callbacks.onStop?.(sid);
        res.writeHead(200).end('ok');
        return;
      }

      res.writeHead(404).end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no address'));
      resolve({ port: addr.port, stop: () => server.close() });
    });

    server.on('error', reject);
  });
}
