import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type SdkEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_use'; name: string; input: string }
  | { type: 'result'; text: string; costUsd: number; durationMs: number; sessionId: string }
  | { type: 'error'; message: string };

export interface SdkSessionOptions {
  prompt: string;
  cwd: string;
  model?: string;
  abortController?: AbortController;
}

export interface SdkResumeOptions extends SdkSessionOptions {
  sessionId: string;
}

export async function* startSdkSession(opts: SdkSessionOptions): AsyncGenerator<SdkEvent> {
  yield* runSdkQuery(opts.prompt, {
    cwd: opts.cwd,
    permissionMode: 'bypassPermissions',
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.abortController ? { abortController: opts.abortController } : {}),
  });
}

export async function* resumeSdkSession(opts: SdkResumeOptions): AsyncGenerator<SdkEvent> {
  yield* runSdkQuery(opts.prompt, {
    cwd: opts.cwd,
    resume: opts.sessionId,
    permissionMode: 'bypassPermissions',
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.abortController ? { abortController: opts.abortController } : {}),
  });
}

async function* runSdkQuery(
  prompt: string,
  options: Record<string, unknown>,
): AsyncGenerator<SdkEvent> {
  // includePartialMessages → SDK emits `stream_event` deltas so we can stream
  // assistant text token-by-token to the Feishu card instead of one block per turn.
  for await (const msg of query({ prompt, options: { includePartialMessages: true, ...options } as any })) {
    yield* translateMessage(msg);
  }
}

function* translateMessage(msg: SDKMessage): Generator<SdkEvent> {
  const m = msg as any;

  if (m.type === 'system' && m.subtype === 'init') {
    yield { type: 'init', sessionId: m.session_id ?? '' };
    return;
  }

  // Incremental token deltas (includePartialMessages). Only text is streamed here;
  // tool_use is taken from the consolidated assistant message below to avoid doubling.
  if (m.type === 'stream_event' && m.event) {
    const ev = m.event;
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      yield { type: 'text_delta', content: ev.delta.text };
    }
    return;
  }

  if (m.type === 'assistant' && m.message?.content) {
    for (const block of m.message.content) {
      // Text already streamed via stream_event deltas — skip to avoid doubling.
      if (block.type === 'tool_use' && block.name) {
        const input = typeof block.input === 'string'
          ? block.input
          : JSON.stringify(block.input ?? '');
        yield { type: 'tool_use', name: block.name, input };
      }
    }
    return;
  }

  if (m.type === 'result') {
    if (m.subtype === 'success') {
      yield {
        type: 'result',
        text: m.result ?? '',
        costUsd: m.total_cost_usd ?? 0,
        durationMs: m.duration_ms ?? 0,
        sessionId: m.session_id ?? '',
      };
    } else {
      yield { type: 'error', message: m.error ?? m.result ?? 'Unknown error' };
    }
  }
}
