import type { ScannedMessage } from '../scanner';
import { basename } from 'node:path';

/**
 * Format a scanned JSONL message into markdown for Feishu.
 */
export function formatForFeishu(msg: ScannedMessage): string | null {
  if (msg.type === 'user') {
    const text = extractText(msg.content);
    if (!text) return null;
    return `**You:**\n${text}`;
  }

  if (msg.type === 'assistant') {
    if (!Array.isArray(msg.content)) return null;

    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'tool_use') {
        const input = typeof block.input === 'string'
          ? block.input.slice(0, 200)
          : JSON.stringify(block.input)?.slice(0, 200);
        parts.push(`\`[tool: ${block.name}]\` ${input ?? ''}`);
      }
    }
    if (parts.length === 0) return null;
    return `**Claude:**\n${parts.join('\n')}`;
  }

  if (msg.type === 'summary') {
    return `_${msg.summaryText}_`;
  }

  return null;
}

/**
 * Generate a thread title from the first user prompt.
 * Format: 【project_name】prompt preview...
 */
export function threadTitle(cwd: string, firstPrompt: string): string {
  const project = basename(cwd);
  const clean = firstPrompt.replace(/\s+/g, ' ').trim();
  const maxLen = 50;
  const prompt = clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
  return `【${project}】${prompt}`;
}

export function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b.type === 'text');
    return textBlock?.text ?? null;
  }
  return null;
}
