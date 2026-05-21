import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { Daemon } from '../daemon/server';
import { discoverCCSessions } from '../daemon/discover';
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
    const daemon = new Daemon({ agents, sessions });
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
  .command('chat')
  .description('Interactive chat with an agent (in-process, no daemon needed)')
  .option('-a, --agent <id>', 'Agent to use', 'claude')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-m, --model <model>', 'Model override')
  .option('-r, --resume <sessionId>', 'Resume a CC session')
  .action(async (opts) => {
    const agents = new Map([['claude', new ClaudeAdapter()]]);
    const sessions = new MemorySessionStore();
    const daemon = new Daemon({ agents, sessions });

    const session = await daemon.createSession({
      agentId: opts.agent,
      cwd: opts.dir,
      model: opts.model,
    });

    if (opts.resume) {
      session.ccSessionId = opts.resume;
      sessions.set(session);
    }

    console.log(`session ${session.id.slice(0, 8)} | agent: ${session.agentId} | cwd: ${session.cwd}`);
    console.log('Type your message. Ctrl+C to exit.\n');

    // Print events as they arrive
    daemon.onEvent((sid, evt) => {
      if (sid !== session.id) return;
      switch (evt.type) {
        case 'text':
          process.stdout.write(evt.content);
          break;
        case 'tool_use':
          console.log(`\n[tool] ${evt.name}`);
          break;
        case 'tool_result':
          console.log(`[tool_result] ${evt.content.slice(0, 200)}`);
          break;
        case 'result':
          console.log(`\n--- done${evt.duration ? ` (${(evt.duration / 1000).toFixed(1)}s)` : ''} ---\n`);
          break;
        case 'error':
          console.error(`\n[error] ${evt.message}\n`);
          break;
      }
    });

    let sending = false;
    let stdinClosed = false;

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => {
      stdinClosed = true;
      if (!sending) process.exit(0);
    });

    const askNext = (): void => {
      if (stdinClosed) return;
      rl.question('> ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed) { askNext(); return; }
        if (trimmed === '/quit' || trimmed === '/exit') {
          await daemon.stop(session.id);
          process.exit(0);
        }
        sending = true;
        try {
          await daemon.send(session.id, trimmed);
        } catch (err) {
          console.error(`[error] ${err}`);
        }
        sending = false;
        if (stdinClosed) process.exit(0);
        askNext();
      });
    };
    askNext();
  });

program
  .command('discover')
  .description('List local Claude Code sessions available for relay')
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
