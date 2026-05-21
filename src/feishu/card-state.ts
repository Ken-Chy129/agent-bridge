import type { ScannedMessage } from '../scanner';

interface ToolInfo {
  name: string;
  summary: string;
}

export interface CardState {
  texts: string[];
  tools: ToolInfo[];
  lastUpdate: number;
}

export function emptyCardState(): CardState {
  return { texts: [], tools: [], lastUpdate: Date.now() };
}

export function reduceMessage(state: CardState, msg: ScannedMessage): CardState {
  if (msg.type === 'user') {
    const content = (msg.raw as any).message?.content;
    const text = extractText(content);
    if (text) {
      return { ...state, texts: [...state.texts, `**You:**\n${text}`], lastUpdate: Date.now() };
    }
  }

  if (msg.type === 'assistant') {
    const content = (msg.raw as any).message?.content;
    if (!Array.isArray(content)) return state;

    const newTexts = [...state.texts];
    const newTools = [...state.tools];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        newTexts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        newTools.push({
          name: block.name,
          summary: summarizeTool(block.name, block.input),
        });
      }
    }

    return { texts: newTexts, tools: newTools, lastUpdate: Date.now() };
  }

  return state;
}

export function renderCardJson(state: CardState, finished: boolean): object {
  const elements: object[] = [];

  // Text content
  const textContent = state.texts.join('\n\n');
  if (textContent.trim()) {
    elements.push({ tag: 'markdown', content: textContent });
  }

  // Tool calls summary
  if (state.tools.length > 0) {
    const toolLines = state.tools.map((t) => `- ${toolIcon(t)} **${t.name}** ${t.summary}`).join('\n');
    const title = `🔧 **${state.tools.length} 个工具调用${finished ? '（已结束）' : ''}**`;
    elements.push({
      tag: 'collapsible_panel',
      expanded: !finished && state.tools.length <= 3,
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

function toolIcon(t: ToolInfo): string {
  return '✅';
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

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b.type === 'text');
    return textBlock?.text ?? null;
  }
  return null;
}
