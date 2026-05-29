import type { Command } from 'commander';
import {
  loadConfig,
  saveConfig,
  hasFeishuConfig,
  configPath,
} from '../feishu/config';
import { startFeishuBridge } from '../feishu/channel';
import { startHookServer } from '../hook/server';
import { installGlobalHooks, uninstallGlobalHooks } from '../hook/settings';
import { runSetupWizard } from '../feishu/wizard';
import { SessionManager } from '../serve/session-manager';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Run daemon — bridge local Claude sessions to Feishu')
    .option('-d, --dir <path>', 'Default working directory for Feishu-initiated sessions', process.cwd())
    .action(async (opts) => {
      if (!hasFeishuConfig()) {
        try {
          const feishuCfg = await runSetupWizard();
          const cfg = loadConfig();
          cfg.feishu = feishuCfg;
          saveConfig(cfg);
          console.log(`配置已保存到 ${configPath()}\n`);
        } catch (err) {
          console.error(`飞书配置失败: ${err}`);
          process.exit(1);
        }
      }

      const cfg = loadConfig();
      const chatId = cfg.feishu!.chatId;
      if (!chatId) {
        console.error('未设置话题群 Chat ID。请运行 agent-bridge config --create-group');
        process.exit(1);
      }

      const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()} ${msg}`);

      const hookServer = await startHookServer({
        onSessionStart: (sessionId, cwd) => {
          manager.handleLocalSession(sessionId, cwd).catch((err) => {
            log(`[error] handleLocalSession failed: ${err}`);
          });
        },
        onStop: (sessionId) => {
          log(`[hook] stop: ${sessionId.slice(0, 8)}`);
        },
      });

      installGlobalHooks(hookServer.port);
      log(`[daemon] hook server on port ${hookServer.port}, global hooks installed`);

      let feishu;
      try {
        feishu = await startFeishuBridge(cfg.feishu!, {
          onMessage: (msg: NormalizedMessage) => {
            if (msg.chatId !== chatId) return;
            const text = msg.content.trim();
            if (!text) return;

            const raw = msg as any;
            const rootId = raw.rootId ?? raw.root_id;
            const userMsgId = raw.messageId ?? raw.message_id;

            log(`[feishu] msg: text="${text.slice(0, 30)}" rootId=${rootId ?? '(none)'}`);

            if (rootId) {
              manager.handleFeishuMessage(chatId, rootId, text, userMsgId).catch((err) => {
                log(`[error] handleFeishuMessage failed: ${err}`);
              });
            } else {
              manager.handleNewFeishuMessage(chatId, text, userMsgId).catch((err) => {
                log(`[error] handleNewFeishuMessage failed: ${err}`);
              });
            }
          },
        });
      } catch (err) {
        console.error(`飞书连接失败: ${err}`);
        uninstallGlobalHooks();
        hookServer.stop();
        process.exit(1);
      }

      const manager = new SessionManager({
        feishu,
        chatId,
        defaultCwd: opts.dir,
        log,
      });

      log(`[daemon] running. Feishu connected. Ctrl+C to stop.`);

      const shutdown = async () => {
        log(`[daemon] shutting down...`);
        await manager.shutdown();
        await feishu.disconnect();
        uninstallGlobalHooks();
        hookServer.stop();
        log(`[daemon] stopped.`);
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await new Promise(() => {});
    });
}
