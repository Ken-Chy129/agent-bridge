import { startSdkSession, resumeSdkSession, type SdkEvent } from '../agent/claude/sdk-runner';
import { createSessionScanner, readLastUserPrompt, readLastAssistantText } from '../scanner';
import { acquireSessionLock, releaseSessionLock } from './session-lock';
import { discoverCCSessions } from '../daemon/discover';
import {
  emptyCardState,
  renderCardJson,
  renderThreadHeaderCard,
  appendText,
  appendTextDelta,
  appendTool,
} from '../feishu/card-state';
import { addWorkingReaction, removeReaction } from '../feishu/reaction';
import type { FeishuBridge, CardStream } from '../feishu/channel';
import type { CardState } from '../feishu/card-state';

interface ManagedSession {
  sessionId: string;
  cwd: string;
  chatId: string;
  threadMsgId: string | null;
  source: 'local' | 'feishu';
  busy: boolean;
  /** PID of the local Claude Code process owning this session (relay mode). */
  localPid?: number;
  cardStream: CardStream | null;
  cardState: CardState;
  cardUpdateTimer: NodeJS.Timeout | null;
  scanner: ReturnType<typeof createSessionScanner> | null;
}

export interface SessionManagerOptions {
  feishu: FeishuBridge;
  chatId: string;
  defaultCwd: string;
  log?: (msg: string) => void;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private threads = new Map<string, string>(); // threadMsgId → sessionId
  private lockedSessions = new Set<string>(); // sessions we hold a bridge lock for
  private readonly feishu: FeishuBridge;
  private readonly chatId: string;
  private readonly defaultCwd: string;
  private readonly log: (msg: string) => void;

  constructor(opts: SessionManagerOptions) {
    this.feishu = opts.feishu;
    this.chatId = opts.chatId;
    this.defaultCwd = opts.defaultCwd;
    this.log = opts.log ?? console.log;
  }

  async handleLocalSession(sessionId: string, cwd: string, localPid?: number): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;

    const holder = acquireSessionLock(sessionId);
    if (holder !== null) {
      this.log(`[session] ${sessionId.slice(0, 8)} already bridged by pid ${holder}, skipping`);
      return false;
    }
    this.lockedSessions.add(sessionId);

    this.log(`[session] local session discovered: ${sessionId.slice(0, 8)}... cwd=${cwd}`);

    const session: ManagedSession = {
      sessionId,
      cwd,
      chatId: this.chatId,
      threadMsgId: null,
      source: 'local',
      busy: false,
      localPid,
      cardStream: null,
      cardState: emptyCardState(),
      cardUpdateTimer: null,
      scanner: null,
    };

    this.sessions.set(sessionId, session);

    const scanner = createSessionScanner({
      workingDirectory: cwd,
      onMessage: async (msg) => {
        if (session.busy) return;
        await this.onScannerMessage(session, msg);
      },
    });
    scanner.initExisting(sessionId);
    scanner.startPolling();
    session.scanner = scanner;
    return true;
  }

  /**
   * Adopt an already-running local session on demand (relay / "take-away" mode):
   * bridge it like a discovered session, then eagerly create the Feishu thread —
   * seeded with the session's last prompt — so an idle session has a reply target
   * immediately, without waiting for new terminal activity.
   */
  async adoptLocalSession(sessionId: string, cwd: string, localPid?: number): Promise<boolean> {
    const acquired = await this.handleLocalSession(sessionId, cwd, localPid);
    if (!acquired) return false;
    const session = this.sessions.get(sessionId);
    if (!session || session.threadMsgId) return true;
    // Seed the thread card with where Claude left off (its last reply), not the
    // user's own prompt — far more useful when picking the session up on a phone.
    const seed =
      readLastAssistantText(cwd, sessionId) ??
      readLastUserPrompt(cwd, sessionId) ??
      '(relayed session)';
    await this.ensureFeishuThread(session, seed);
    return true;
  }

  async handleFeishuMessage(chatId: string, rootMsgId: string, text: string, userMsgId?: string): Promise<void> {
    const sessionId = this.threads.get(rootMsgId);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.busy) {
      this.log(`[session] ${sessionId.slice(0, 8)} busy, dropping message`);
      return;
    }

    // Guard against dual-writer corruption: if the local Claude Code terminal is
    // still actively running this session, do NOT fire a competing SDK resume.
    if (this.isLocalSessionBusy(session)) {
      this.log(`[session] ${sessionId.slice(0, 8)} locally busy, asking user to wait`);
      try {
        await this.feishu.sendText(
          chatId,
          '⏳ 本地会话正在运行中,请等它空闲后再发。',
          { replyTo: rootMsgId, replyInThread: true },
        );
      } catch {}
      return;
    }

    this.log(`[session] feishu message for ${sessionId.slice(0, 8)}: ${text.slice(0, 50)}`);

    let reactionId: string | undefined;
    if (userMsgId) {
      reactionId = await addWorkingReaction(this.feishu.channel, userMsgId);
    }

    session.busy = true;
    if (session.scanner) {
      session.scanner.cleanup();
      session.scanner = null;
    }
    try {
      const events = resumeSdkSession({
        prompt: text,
        sessionId: session.sessionId,
        cwd: session.cwd,
      });
      await this.processSdkEvents(session, events, rootMsgId);
    } finally {
      session.busy = false;
      if (reactionId && userMsgId) {
        removeReaction(this.feishu.channel, userMsgId, reactionId).catch(() => {});
      }
    }
  }

  async handleNewFeishuMessage(chatId: string, text: string, userMsgId?: string): Promise<void> {
    this.log(`[session] new feishu session: ${text.slice(0, 50)}`);

    let reactionId: string | undefined;
    if (userMsgId) {
      reactionId = await addWorkingReaction(this.feishu.channel, userMsgId);
    }

    const project = this.defaultCwd.split('/').pop() || this.defaultCwd;
    let threadMsgId: string | null = null;
    try {
      const card = renderThreadHeaderCard({ project, prompt: text, source: 'feishu' });
      threadMsgId = await this.feishu.sendCard(chatId, card);
    } catch {}
    if (!threadMsgId) {
      if (reactionId && userMsgId) removeReaction(this.feishu.channel, userMsgId, reactionId).catch(() => {});
      return;
    }

    const session: ManagedSession = {
      sessionId: '',
      cwd: this.defaultCwd,
      chatId,
      threadMsgId,
      source: 'feishu',
      busy: true,
      cardStream: null,
      cardState: emptyCardState(),
      cardUpdateTimer: null,
      scanner: null,
    };

    try {
      const events = startSdkSession({
        prompt: text,
        cwd: this.defaultCwd,
      });

      for await (const evt of events) {
        if (evt.type === 'init' && evt.sessionId) {
          session.sessionId = evt.sessionId;
          this.sessions.set(evt.sessionId, session);
          this.threads.set(threadMsgId, evt.sessionId);
        }
        await this.handleSdkEvent(session, evt, threadMsgId);
      }
    } finally {
      session.busy = false;
      this.finalizeCard(session);
      if (reactionId && userMsgId) {
        removeReaction(this.feishu.channel, userMsgId, reactionId).catch(() => {});
      }
    }
  }

  /**
   * Is the local Claude Code terminal still actively running this session?
   * Checked against the owning PID's live status, so our own SDK-resume process
   * (a different PID) never trips it.
   */
  private isLocalSessionBusy(session: ManagedSession): boolean {
    if (!session.localPid) return false;
    const found = discoverCCSessions().find(
      (s) => s.pid === session.localPid && s.sessionId === session.sessionId,
    );
    return found?.status === 'busy';
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.scanner?.cleanup();
      if (session.cardUpdateTimer) clearTimeout(session.cardUpdateTimer);
    }
    for (const sessionId of this.lockedSessions) releaseSessionLock(sessionId);
    this.lockedSessions.clear();
    this.sessions.clear();
    this.threads.clear();
  }

  private async processSdkEvents(
    session: ManagedSession,
    events: AsyncGenerator<SdkEvent>,
    replyMsgId: string,
  ): Promise<void> {
    try {
      for await (const evt of events) {
        await this.handleSdkEvent(session, evt, replyMsgId);
      }
    } finally {
      this.finalizeCard(session);
    }
  }

  private async ensureCardStream(session: ManagedSession, replyMsgId: string): Promise<void> {
    if (session.cardStream) return;
    session.cardState = emptyCardState();
    try {
      session.cardStream = await this.feishu.streamCard(
        session.chatId,
        renderCardJson(session.cardState, false),
        { replyTo: replyMsgId, replyInThread: true },
      );
    } catch {}
  }

  private async handleSdkEvent(session: ManagedSession, evt: SdkEvent, replyMsgId: string): Promise<void> {
    if (evt.type === 'text') {
      await this.ensureCardStream(session, replyMsgId);
      session.cardState = appendText(session.cardState, evt.content);
      this.scheduleCardUpdate(session);
    }

    if (evt.type === 'text_delta') {
      await this.ensureCardStream(session, replyMsgId);
      session.cardState = appendTextDelta(session.cardState, evt.content);
      this.scheduleCardUpdate(session);
    }

    if (evt.type === 'tool_use') {
      await this.ensureCardStream(session, replyMsgId);
      session.cardState = appendTool(session.cardState, evt.name, evt.input.slice(0, 60));
      this.scheduleCardUpdate(session);
    }

    if (evt.type === 'result') {
      if (evt.sessionId && !session.sessionId) {
        session.sessionId = evt.sessionId;
      }
      this.log(`[session] ${session.sessionId.slice(0, 8)} done: ${evt.durationMs}ms $${evt.costUsd.toFixed(4)}`);
    }

    if (evt.type === 'error') {
      this.log(`[session] ${session.sessionId.slice(0, 8)} error: ${evt.message}`);
      try {
        await this.feishu.sendText(
          session.chatId,
          `❌ Error: ${evt.message}`,
          { replyTo: replyMsgId, replyInThread: true },
        );
      } catch {}
    }
  }

  private scheduleCardUpdate(session: ManagedSession): void {
    if (!session.cardStream) return;
    if (session.cardUpdateTimer) clearTimeout(session.cardUpdateTimer);
    session.cardUpdateTimer = setTimeout(async () => {
      try {
        await session.cardStream?.update(renderCardJson(session.cardState, false));
      } catch {}
    }, 300);
  }

  private finalizeCard(session: ManagedSession): void {
    if (session.cardUpdateTimer) clearTimeout(session.cardUpdateTimer);
    if (session.cardStream) {
      session.cardStream.update(renderCardJson(session.cardState, true)).catch(() => {});
      session.cardStream = null;
    }
    session.cardState = emptyCardState();
  }

  private async ensureFeishuThread(session: ManagedSession, firstPrompt: string): Promise<void> {
    if (session.threadMsgId) return;

    const project = session.cwd.split('/').pop() || session.cwd;
    const card = renderThreadHeaderCard({
      project,
      prompt: firstPrompt,
      source: session.source,
    });
    try {
      const msgId = await this.feishu.sendCard(session.chatId, card);
      if (msgId) {
        session.threadMsgId = msgId;
        this.threads.set(msgId, session.sessionId);
        this.log(`[session] feishu thread created for ${session.sessionId.slice(0, 8)}: ${project}`);
      }
    } catch (err) {
      this.log(`[session] failed to create feishu thread: ${err}`);
    }
  }

  private async onScannerMessage(session: ManagedSession, msg: any): Promise<void> {
    if (msg.type === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
          ? msg.content.find((b: any) => b.type === 'text')?.text
          : null);
      if (text) {
        await this.ensureFeishuThread(session, text);
      }
      return;
    }

    if (msg.type !== 'assistant' || !session.threadMsgId) return;

    if (!session.cardStream) {
      session.cardState = emptyCardState();
      try {
        session.cardStream = await this.feishu.streamCard(
          session.chatId,
          renderCardJson(session.cardState, false),
          { replyTo: session.threadMsgId, replyInThread: true },
        );
      } catch {}
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          session.cardState = appendText(session.cardState, block.text);
        } else if (block.type === 'tool_use' && block.name) {
          session.cardState = appendTool(session.cardState, block.name, '');
        }
      }
      this.scheduleCardUpdate(session);
    }

    if (msg.stopReason === 'end_turn') {
      this.finalizeCard(session);
    }
  }
}
