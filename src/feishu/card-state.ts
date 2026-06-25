import type { ScannedMessage } from '../scanner';

/**
 * An ordered list of segments preserving the real text/tool sequence, so the
 * card renders tool calls in the position they actually happened (e.g. a Read
 * before the summary that followed it) instead of always dumping tools at the end.
 */
export type CardSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; name: string; summary: string };

export interface CardState {
  segments: CardSegment[];
  lastUpdate: number;
}

export function emptyCardState(): CardState {
  return { segments: [], lastUpdate: Date.now() };
}

/** Append a completed text block. */
export function appendText(state: CardState, content: string): CardState {
  return { segments: [...state.segments, { kind: 'text', content }], lastUpdate: Date.now() };
}

/** Append a streaming text delta: extend the trailing text segment, or start a new one. */
export function appendTextDelta(state: CardState, delta: string): CardState {
  const segments = [...state.segments];
  const last = segments[segments.length - 1];
  if (last && last.kind === 'text') {
    segments[segments.length - 1] = { kind: 'text', content: last.content + delta };
  } else {
    segments.push({ kind: 'text', content: delta });
  }
  return { segments, lastUpdate: Date.now() };
}

/** Append a tool call (closes any open text run). */
export function appendTool(state: CardState, name: string, summary: string): CardState {
  return { segments: [...state.segments, { kind: 'tool', name, summary }], lastUpdate: Date.now() };
}

export function reduceMessage(state: CardState, msg: ScannedMessage): CardState {
  if (msg.type !== 'assistant' || !Array.isArray(msg.content)) return state;

  let next = state;
  for (const block of msg.content as any[]) {
    if (block.type === 'text' && block.text) {
      next = appendText(next, block.text);
    } else if (block.type === 'tool_use' && block.name) {
      next = appendTool(next, block.name, summarizeTool(block.name, block.input));
    }
  }
  return next;
}

export function renderCardJson(state: CardState, finished: boolean): object {
  const elements: object[] = [];

  // Render segments in their real order; group consecutive tool calls into one panel.
  const segs = state.segments;
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    if (seg.kind === 'text') {
      if (seg.content.trim()) elements.push({ tag: 'markdown', content: seg.content });
      i++;
      continue;
    }
    const group: Array<{ name: string; summary: string }> = [];
    while (i < segs.length && segs[i].kind === 'tool') {
      const t = segs[i] as { kind: 'tool'; name: string; summary: string };
      group.push({ name: t.name, summary: t.summary });
      i++;
    }
    const toolLines = group.map((t) => `- ${toolIcon(t)} **${t.name}** ${t.summary}`).join('\n');
    const title = `🔧 **${group.length} 个工具调用${finished ? '（已结束）' : ''}**`;
    elements.push({
      tag: 'collapsible_panel',
      expanded: !finished && group.length <= 3,
      header: {
        title: { tag: 'markdown', content: title },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'blue', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [{ tag: 'markdown', content: toolLines, text_size: 'notation' }],
    });
  }

  // Footer
  if (!finished) {
    elements.push({ tag: 'markdown', content: '⏳ _运行中..._', text_size: 'notation' });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '_等待响应..._' });
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: !finished,
      summary: { content: finished ? '已完成' : '运行中...' },
    },
    body: { elements },
  };
}

export function renderThreadHeaderCard(opts: {
  project: string;
  prompt: string;
  source: 'local' | 'feishu';
}): object {
  const promptPreview = opts.prompt.length > 200
    ? opts.prompt.slice(0, 200) + '...'
    : opts.prompt;

  const sourceLabel = opts.source === 'local'
    ? '💻 Terminal'
    : '💬 Feishu';

  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: `📁 ${opts.project}` },
      template: 'blue',
    },
    body: {
      elements: [
        { tag: 'markdown', content: promptPreview },
        { tag: 'hr' },
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{ tag: 'markdown', content: '🤖 Claude Code', text_size: 'notation' }],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [{ tag: 'markdown', content: sourceLabel, text_size: 'notation' }],
            },
          ],
        },
      ],
    },
  };
}

function toolIcon(t: { name: string }): string {
  switch (t.name) {
    case 'Bash': return '⚡';
    case 'Read': return '📖';
    case 'Edit': case 'Write': return '✏️';
    case 'Grep': return '🔍';
    case 'WebSearch': return '🌐';
    case 'Agent': return '🤖';
    default: return '🔧';
  }
}

function summarizeTool(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const pick = (key: string, max = 60): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    const clean = v.replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max) + '…' : clean;
  };

  switch (name) {
    case 'Bash': return pick('command');
    case 'Read': case 'Edit': case 'Write': return shortenPath(pick('file_path'));
    case 'Grep': return `\`${pick('pattern', 30)}\` in ${shortenPath(pick('path', 30))}`;
    case 'WebSearch': return pick('query');
    case 'Agent': return pick('description') || pick('prompt', 40);
    default: return pick('command') || pick('file_path') || pick('query') || '';
  }
}

function shortenPath(p: string): string {
  if (!p) return p;
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

