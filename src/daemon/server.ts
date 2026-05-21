import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { DaemonApi, LocalSession } from './types';
import type { Session, SessionStore } from '../session/types';
import { discoverCCSessions } from './discover';
import type { AgentAdapter, AgentPipe } from '../agent/types';

const DATA_DIR = resolve(homedir(), '.agent-bridge');
const SOCKET_PATH = resolve(DATA_DIR, 'daemon.sock');

export interface DaemonDeps {
  agents: Map<string, AgentAdapter>;
  sessions: SessionStore;
  onSessionEvent?: (sessionId: string, event: unknown) => void;
}

export class Daemon implements DaemonApi {
  private readonly agents: Map<string, AgentAdapter>;
  private readonly store: SessionStore;
  private readonly pipes = new Map<string, AgentPipe>();
  private server: Server | null = null;
  private readonly onSessionEvent?: (sessionId: string, event: unknown) => void;

  constructor(deps: DaemonDeps) {
    this.agents = deps.agents;
    this.store = deps.sessions;
    this.onSessionEvent = deps.onSessionEvent;
  }

  async start(): Promise<void> {
    mkdirSync(DATA_DIR, { recursive: true });
    this.server = createServer((req, res) => this.handleRequest(req, res));
    // TODO: switch to Unix socket for production; HTTP for now during dev
    this.server.listen(SOCKET_PATH, () => {
      console.log(`daemon listening on ${SOCKET_PATH}`);
    });
  }

  async shutdown(): Promise<void> {
    for (const pipe of this.pipes.values()) {
      await pipe.stop();
    }
    this.pipes.clear();
    await this.store.flush();
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  sessions(): Session[] {
    return this.store.list();
  }

  async createSession(opts: {
    agentId: string;
    cwd: string;
    chatId?: string;
    threadId?: string;
    model?: string;
  }): Promise<Session> {
    const agent = this.agents.get(opts.agentId);
    if (!agent) throw new Error(`unknown agent: ${opts.agentId}`);

    const pipe = agent.pipe({
      cwd: opts.cwd,
      model: opts.model,
    });

    const session: Session = {
      id: crypto.randomUUID(),
      agentId: opts.agentId,
      cwd: opts.cwd,
      chatId: opts.chatId,
      threadId: opts.threadId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'pipe',
    };

    this.store.set(session);
    this.pipes.set(session.id, pipe);

    // Fan out events to listeners
    void this.drainEvents(session.id, pipe);

    return session;
  }

  send(sessionId: string, prompt: string): void {
    const pipe = this.pipes.get(sessionId);
    if (!pipe) throw new Error(`no active pipe for session ${sessionId}`);
    pipe.send(prompt);
    const session = this.store.get(sessionId);
    if (session) {
      session.updatedAt = Date.now();
      this.store.set(session);
    }
  }

  bind(sessionId: string, chatId: string, threadId: string): void {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    session.chatId = chatId;
    session.threadId = threadId;
    session.updatedAt = Date.now();
    this.store.set(session);
  }

  async relay(pid: number, chatId: string, threadId: string): Promise<Session> {
    // TODO: implement JSONL tailing + resume takeover
    const locals = this.discoverLocalSessions();
    const target = locals.find((s) => s.pid === pid);
    if (!target) throw new Error(`no local CC session with pid ${pid}`);

    const session: Session = {
      id: crypto.randomUUID(),
      agentId: 'claude',
      cwd: target.cwd,
      chatId,
      threadId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'relay',
      relayPid: pid,
    };
    this.store.set(session);
    return session;
  }

  async stop(sessionId: string): Promise<void> {
    const pipe = this.pipes.get(sessionId);
    if (pipe) {
      await pipe.stop();
      this.pipes.delete(sessionId);
    }
    this.store.remove(sessionId);
  }

  discoverLocalSessions(): LocalSession[] {
    return discoverCCSessions();
  }

  private async drainEvents(sessionId: string, pipe: AgentPipe): Promise<void> {
    try {
      for await (const evt of pipe.events) {
        this.onSessionEvent?.(sessionId, evt);
      }
    } catch {
      // pipe closed
    }
  }

  private handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    // Minimal JSON-RPC style API; will be fleshed out
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { method, params } = JSON.parse(body || '{}');
        const result = this.dispatch(method, params);
        Promise.resolve(result).then((r) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: r }));
        }).catch((err: Error) => {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'sessions': return this.sessions();
      case 'createSession': return this.createSession(params as Parameters<DaemonApi['createSession']>[0]);
      case 'send': { this.send(params.sessionId as string, params.prompt as string); return null; }
      case 'bind': { this.bind(params.sessionId as string, params.chatId as string, params.threadId as string); return null; }
      case 'relay': return this.relay(params.pid as number, params.chatId as string, params.threadId as string);
      case 'stop': return this.stop(params.sessionId as string);
      case 'discover': return this.discoverLocalSessions();
      default: throw new Error(`unknown method: ${method}`);
    }
  }
}
