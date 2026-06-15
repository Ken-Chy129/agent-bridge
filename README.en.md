# agent-bridge

Bridge local coding agents (Claude Code, Codex, ...) to Feishu/Lark with daemon-hosted multi-view sessions.

Run Claude Code locally, see everything in a Feishu topic group — and reply from Feishu to steer the agent.

## Prerequisites

- Node.js >= 20
- A Feishu/Lark custom app with Bot and messaging permissions ([create one here](https://open.feishu.cn/app))

## Install

```bash
npm i -g @ken-chy129/agent-bridge
```

Or run directly:

```bash
npx @ken-chy129/agent-bridge
```

## Quick Start

### 1. Configure Feishu App

```bash
agent-bridge config
```

Scans a QR code to authorize your Feishu app and sets up a topic group. Config is saved to `~/.agent-bridge/config.json`.

```bash
agent-bridge config --chat-id <chatId>        # Set topic group directly
agent-bridge config --create-group "My Group"  # Create a new topic group
agent-bridge config --reset                    # Re-run setup wizard
```

### 2. Start a Session

**Interactive mode** — start Claude Code with Feishu sync:

```bash
agent-bridge chat -d /path/to/project
```

| Flag | Description |
|------|-------------|
| `-d, --dir <path>` | Working directory |
| `-m, --model <model>` | Model override |
| `-r, --resume <id>` | Resume a session by ID |
| `-c, --continue` | Continue the most recent session |
| `--no-feishu` | Disable Feishu bridge (local only) |

**Daemon mode** — auto-bridge all local Claude Code sessions:

```bash
agent-bridge serve -d /path/to/default/dir
```

Installs global `SessionStart` hooks so any Claude Code session you start in any terminal is automatically discovered and bridged to Feishu. Feishu users can also start new sessions by sending a message directly.

### 3. Utility Commands

```bash
agent-bridge discover            # List all active Claude Code sessions
agent-bridge relay <sessionId>   # Bridge an existing session to Feishu
```

## How It Works

```
Terminal (Claude Code)  ←→  agent-bridge  ←→  Feishu Topic Group
       ↑                        ↑                      ↑
   local agent            JSONL scanner +          card messages
   stdin/stdout           SDK resume API           in threads
```

- **Local → Feishu**: Tails the Claude Code JSONL output, renders assistant/tool messages as Feishu interactive cards in a topic thread.
- **Feishu → Local**: Incoming Feishu messages are injected into the Claude session via the Claude Agent SDK resume API.
- **Daemon mode**: A hook server listens for `SessionStart` events to auto-discover new sessions.

## License

MIT
