import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.agent-bridge');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** 'feishu' or 'lark' */
  tenant: 'feishu' | 'lark';
  /** Topic group chat ID where threads are created. */
  chatId?: string;
}

export interface BridgeConfig {
  feishu?: FeishuConfig;
}

export function loadConfig(): BridgeConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: BridgeConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function hasFeishuConfig(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.feishu?.appId && cfg.feishu?.appSecret);
}

export function configPath(): string {
  return CONFIG_PATH;
}
