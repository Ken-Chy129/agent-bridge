import { Command } from 'commander';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { discoverCCSessions } from '../daemon/discover';
import { loop } from '../loop';

const program = new Command()
  .name('agent-bridge')
  .description('Bridge local coding agents to Feishu/Lark with daemon-hosted multi-view sessions')
  .version('0.1.0');

program
  .command('chat', { isDefault: true })
  .description('Start Claude Code with Feishu bridge (native TUI + JSONL relay)')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-m, --model <model>', 'Model override')
  .option('-r, --resume <sessionId>', 'Resume a CC session by ID')
  .option('-c, --continue', 'Continue the most recent session')
  .action(async (opts) => {
    const agent = new ClaudeAdapter();
    const claudeArgs: string[] = [];
    if (opts.continue) claudeArgs.push('--continue');

    const exitCode = await loop({
      cwd: opts.dir,
      agent,
      resumeSessionId: opts.resume,
      model: opts.model,
      claudeArgs,
      onSessionId: (sid) => {
        // TODO: when Feishu is connected, create thread here
        console.error(`[bridge] session: ${sid}`);
      },
      onScanMessage: (msg) => {
        // TODO: push to Feishu thread
        if (msg.type === 'user') {
          const content = (msg.raw as any).message?.content;
          const preview = typeof content === 'string'
            ? content.slice(0, 60)
            : JSON.stringify(content)?.slice(0, 60);
          console.error(`[bridge] scan: user → ${preview}`);
        } else if (msg.type === 'assistant') {
          console.error(`[bridge] scan: assistant message`);
        }
      },
      onModeChange: (mode) => {
        if (mode === 'remote') {
          console.log('\n💬 会话已转到飞书，按 Ctrl+C 退出');
        } else {
          console.log('\n⌨️ 切回终端模式');
        }
      },
    });

    process.exit(exitCode);
  });

program
  .command('discover')
  .description('List local Claude Code sessions')
  .action(() => {
    const sessions = discoverCCSessions();
    if (sessions.length === 0) {
      console.log('No active Claude Code sessions found.');
      return;
    }
    console.log(`Found ${sessions.length} session(s):\n`);
    for (const s of sessions) {
      const status = s.status === 'idle' ? 'idle' : s.status === 'busy' ? 'busy' : s.status;
      const age = Math.round((Date.now() - s.startedAt) / 60000);
      console.log(`  PID ${s.pid}  [${status}]  ${s.cwd}`);
      console.log(`    session: ${s.sessionId}  age: ${age}m  ver: ${s.version}`);
      console.log();
    }
  });

program.parse();
