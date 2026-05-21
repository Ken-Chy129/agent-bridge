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
  /** Send a streaming card to a chat. Returns a controller to update or finalize. */
  streamCard(chatId: string, initialCard: object, opts?: { replyTo?: string; replyInThread?: boolean }): Promise<CardStream>;
  /** Send a simple markdown message. */
  sendMarkdown(chatId: string, content: string, opts?: { replyTo?: string }): Promise<void>;
  disconnect(): Promise<void>;
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
      let resolve: ((cs: CardStream) => void) | null = null;
      const ready = new Promise<CardStream>((r) => { resolve = r; });

      await channel.stream(
        chatId,
        {
          card: {
            initial: initialCard,
            producer: async (ctrl) => {
              const cs: CardStream = {
                async update(card) { await ctrl.update(card); },
              };
              resolve!(cs);
              // Keep producer alive until disconnect
              await new Promise(() => {});
            },
          },
        },
        opts ?? {},
      );

      return ready;
    },

    async sendMarkdown(chatId, content, opts) {
      await channel.send(chatId, { markdown: content }, opts ?? {});
    },

    async disconnect() {
      await channel.disconnect();
    },
  };
}
