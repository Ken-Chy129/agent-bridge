import { Command } from 'commander';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { Daemon } from '../daemon/server';
import { MemorySessionStore } from '../session/store';

const program = new Command()
  .name('agent-bridge')
  .description('Bridge local coding agents to Feishu/Lark with daemon-hosted multi-view sessions')
  .version('0.1.0');

program
  .command('start')
  .description('Start the daemon')
  .action(async () => {
    const agents = new Map([['claude', new ClaudeAdapter()]]);
    const sessions = new MemorySessionStore();
    const daemon = new Daemon({
      agents,
      sessions,
      onSessionEvent: (sid, evt) => {
        // TODO: fan out to Feishu views
        console.log(`[${sid.slice(0, 8)}]`, JSON.stringify(evt));
      },
    });
    await daemon.start();

    const shutdown = async () => {
      console.log('\nshutting down...');
      await daemon.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('discover')
  .description('List local Claude Code sessions available for relay')
  .action(() => {
    const { discoverCCSessions } = require('../daemon/discover');
    const sessions = discoverCCSessions();
    if (sessions.length === 0) {
      console.log('No active Claude Code sessions found.');
      return;
    }
    for (const s of sessions) {
      const status = s.status === 'idle' ? '💤 idle' : s.status === 'busy' ? '⚡ busy' : s.status;
      console.log(`  PID ${s.pid}  ${status}  ${s.cwd}  (${s.version})`);
    }
  });

program
  .command('sessions')
  .description('List daemon-managed sessions')
  .action(async () => {
    // TODO: call daemon API via socket
    console.log('(not implemented yet — daemon API call)');
  });

program.parse();
