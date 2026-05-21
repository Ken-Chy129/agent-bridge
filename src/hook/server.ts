import { createServer, type Server } from 'node:http';

/**
 * Lightweight HTTP server that receives Claude's SessionStart hook.
 * Claude spawns a hook command that POSTs session data to us.
 */
export async function startHookServer(
  onSession: (sessionId: string) => void,
): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/hook/session-start') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const sid = data.session_id ?? data.sessionId;
          if (sid) onSession(sid);
        } catch {}
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
