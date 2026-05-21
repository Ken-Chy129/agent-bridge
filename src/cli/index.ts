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

program
  .command('relay [sessionId]')
  .description('Relay an existing Claude Code session (observe JSONL in real-time)')
  .action(async (sessionId?: string) => {
    const allSessions = discoverCCSessions();

    // If no session ID given, let user pick or use the most recent
    let target = sessionId
      ? allSessions.find((s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId!))
      : null;

    if (!target && !sessionId) {
      if (allSessions.length === 0) {
        console.log('No active Claude Code sessions found. Start one with `claude` first.');
        process.exit(1);
      }
      if (allSessions.length === 1) {
        target = allSessions[0];
      } else {
        console.log('Multiple sessions found, pick one:\n');
        for (let i = 0; i < allSessions.length; i++) {
          const s = allSessions[i];
          const status = s.status === 'idle' ? 'idle' : s.status === 'busy' ? 'busy' : s.status;
          console.log(`  ${i + 1}) PID ${s.pid} [${status}] ${s.cwd}`);
          console.log(`     session: ${s.sessionId}`);
        }
        console.log(`\nRun: agent-bridge relay <sessionId>`);
        process.exit(0);
      }
    }

    if (!target) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }

    console.log(`Relaying session ${target.sessionId.slice(0, 8)}...`);
    console.log(`  PID: ${target.pid} | cwd: ${target.cwd} | status: ${target.status}`);
    console.log(`  Watching JSONL for real-time updates. Ctrl+C to stop.\n`);

    const { createSessionScanner } = await import('../scanner');
    const scanner = createSessionScanner({
      workingDirectory: target.cwd,
      onMessage: (msg) => {
        const ts = new Date().toLocaleTimeString();
        if (msg.type === 'user') {
          const content = (msg.raw as any).message?.content;
          const preview = typeof content === 'string'
            ? content.slice(0, 80)
            : JSON.stringify(content)?.slice(0, 80);
          console.log(`[${ts}] user → ${preview}`);
        } else if (msg.type === 'assistant') {
          const content = (msg.raw as any).message?.content;
          let preview = '';
          if (Array.isArray(content)) {
            const text = content.find((b: any) => b.type === 'text');
            if (text?.text) preview = text.text.slice(0, 80);
            const tools = content.filter((b: any) => b.type === 'tool_use');
            if (tools.length > 0) preview += ` [+${tools.length} tool calls]`;
          }
          console.log(`[${ts}] assistant → ${preview || '(message)'}`);
        } else if (msg.type === 'summary') {
          console.log(`[${ts}] summary → ${(msg.raw as any).summary?.slice(0, 80)}`);
        }
        // TODO: push to Feishu thread
      },
    });

    scanner.initExisting(target.sessionId);
    scanner.startPolling();

    // Keep alive until Ctrl+C
    process.on('SIGINT', () => {
      scanner.cleanup();
      console.log('\nRelay stopped.');
      process.exit(0);
    });

    // Keep the process alive
    await new Promise(() => {});
  });

program.parse();
