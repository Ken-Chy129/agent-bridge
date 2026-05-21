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
  streamCard(chatId: string, initialCard: object, opts?: SendOpts): Promise<CardStream>;
  /** Send markdown, returns message_id. */
  sendMarkdown(chatId: string, content: string, opts?: SendOpts): Promise<string | null>;
  disconnect(): Promise<void>;
}

export interface SendOpts {
  replyTo?: string;
  replyInThread?: boolean;
}

export interface CardStream {
  update(card: object): Promise<void>;
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
    outbound: {
      streamThrottleMs: 500,
    },
  });

  channel.on({
    message: async (msg) => { callbacks.onMessage?.(msg); },
    reconnecting: () => {},
    reconnected: () => {},
    error: () => {},
  });

  await channel.connect();

  return {
    channel,

    async streamCard(chatId, initialCard, opts) {
      return new Promise<CardStream>((resolveCS) => {
        channel.stream(
          chatId,
          {
            card: {
              initial: initialCard,
              producer: async (ctrl) => {
                resolveCS({
                  async update(card) { await ctrl.update(card); },
                });
                await new Promise(() => {});
              },
            },
          },
          opts ?? {},
        ).catch(() => {});
      });
    },

    async sendMarkdown(chatId, content, opts) {
      const resp = await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
          ...(opts?.replyTo ? { reply_in_thread: opts.replyInThread ?? false } : {}),
        },
      });
      return (resp as any)?.data?.message_id ?? null;
    },

    async disconnect() {
      await channel.disconnect();
    },
  };
}
