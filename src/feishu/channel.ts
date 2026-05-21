import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from './config';

export interface FeishuBridge {
  channel: LarkChannel;
  /** Send markdown to a chat, optionally in a thread. */
  sendMarkdown(chatId: string, content: string, opts?: { threadId?: string; replyTo?: string }): Promise<void>;
  /** Create a thread (reply to a message in a topic group). */
  createThread(chatId: string, title: string): Promise<string | null>;
  disconnect(): Promise<void>;
}

export interface FeishuBridgeCallbacks {
  onMessage?: (msg: NormalizedMessage) => void;
}

export async function startFeishuBridge(
  config: FeishuConfig,
  callbacks: FeishuBridgeCallbacks = {},
): Promise<FeishuBridge> {
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'agent-bridge',
    loggerLevel: LoggerLevel.warn,
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
  });

  channel.on({
    message: async (msg) => {
      callbacks.onMessage?.(msg);
    },
    reconnecting: () => {
      console.error('[feishu] reconnecting...');
    },
    reconnected: () => {
      console.error('[feishu] reconnected');
    },
    error: (err) => {
      console.error('[feishu] error:', err?.message);
    },
  });

  await channel.connect();

  const identity = channel.botIdentity;
  console.error(`[feishu] connected as ${identity?.name ?? 'unknown'}`);

  return {
    channel,

    async sendMarkdown(chatId, content, opts) {
      const sendOpts: Record<string, unknown> = {};
      if (opts?.replyTo) sendOpts.replyTo = opts.replyTo;
      if (opts?.threadId) sendOpts.replyInThread = true;

      await channel.send(chatId, { markdown: content }, sendOpts);
    },

    async createThread(chatId, title) {
      // In a topic-mode group, sending a message at the top level creates a new thread.
      // The thread_id is returned in the send response.
      try {
        const resp = await channel.rawClient.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify({
              config: { update_multi: true },
              elements: [
                {
                  tag: 'markdown',
                  content: `**${title}**\n\n_会话已连接，等待消息..._`,
                },
              ],
            }),
          },
        });
        const msgId = (resp as any)?.data?.message_id;
        return msgId ?? null;
      } catch (err) {
        console.error('[feishu] createThread failed:', err);
        return null;
      }
    },

    async disconnect() {
      await channel.disconnect();
    },
  };
}
