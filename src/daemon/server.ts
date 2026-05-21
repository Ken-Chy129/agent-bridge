import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, unlinkSync } from 'node:fs';
import type { DaemonApi, LocalSession } from './types';
import type { Session, SessionStore } from '../session/types';
import { discoverCCSessions } from './discover';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';

const DATA_DIR = resolve(homedir(), '.agent-bridge');
const SOCKET_PATH = resolve(DATA_DIR, 'daemon.sock');

export interface DaemonDeps {
  agents: Map<string, AgentAdapter>;
  sessions: SessionStore;
}

export type SessionEventHandler = (sessionId: string, event: AgentEvent) => void;

export class Daemon implements DaemonApi {
  private readonly agents: Map<string, AgentAdapter>;
  private readonly store: SessionStore;
  private readonly activeRuns = new Map<string, AgentRun>();
  private readonly listeners = new Set<SessionEventHandler>();
  private server: Server | null = null;

  constructor(deps: DaemonDeps) {
    this.agents = deps.agents;
    this.store = deps.sessions;
  }

  onEvent(handler: SessionEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(sessionId: string, event: AgentEvent): void {
    for (const handler of this.listeners) {
      handler(sessionId, event);
    }
  }

  async start(): Promise<void> {
    mkdirSync(DATA_DIR, { recursive: true });
    try { unlinkSync(SOCKET_PATH); } catch {}
    this.server = createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(SOCKET_PATH, () => {
        console.log(`daemon listening on ${SOCKET_PATH}`);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    for (const run of this.activeRuns.values()) {
      await run.stop();
    }
    this.activeRuns.clear();
    await this.store.flush();
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  // --- DaemonApi ---

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

    const session: Session = {
      id: crypto.randomUUID(),
      agentId: opts.agentId,
      cwd: opts.cwd,
      chatId: opts.chatId,
      threadId: opts.threadId,
      model: opts.model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'managed',
    };
    this.store.set(session);
    return session;
  }

  async send(sessionId: string, prompt: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    const agent = this.agents.get(session.agentId);
    if (!agent) throw new Error(`unknown agent: ${session.agentId}`);

    // Stop any existing run on this session
    const existing = this.activeRuns.get(sessionId);
    if (existing) {
      await existing.stop();
      this.activeRuns.delete(sessionId);
    }

    const run = agent.run({
      prompt,
      sessionId: session.ccSessionId,
      cwd: session.cwd,
      model: session.model,
    });
    this.activeRuns.set(sessionId, run);

    // Drain events and emit to listeners. Break on 'result' — some CC
    // versions don't close stdout immediately after the result event.
    try {
      for await (const evt of run.events) {
        if (evt.type === 'system' && evt.sessionId) {
          session.ccSessionId = evt.sessionId;
          session.updatedAt = Date.now();
          this.store.set(session);
        }
        this.emit(sessionId, evt);
        if (evt.type === 'result' || evt.type === 'error') break;
      }
    } finally {
      this.activeRuns.delete(sessionId);
      const exited = await run.waitForExit(2000);
      if (!exited) await run.stop();
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
      ccSessionId: target.sessionId,
    };
    this.store.set(session);
    return session;
  }

  async stop(sessionId: string): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (run) {
      await run.stop();
      this.activeRuns.delete(sessionId);
    }
  }

  discoverLocalSessions(): LocalSession[] {
    return discoverCCSessions();
  }

  // --- HTTP API ---

  private handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
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
      case 'send': return this.send(params.sessionId as string, params.prompt as string);
      case 'bind': { this.bind(params.sessionId as string, params.chatId as string, params.threadId as string); return null; }
      case 'relay': return this.relay(params.pid as number, params.chatId as string, params.threadId as string);
      case 'stop': return this.stop(params.sessionId as string);
      case 'discover': return this.discoverLocalSessions();
      default: throw new Error(`unknown method: ${method}`);
    }
  }
}
