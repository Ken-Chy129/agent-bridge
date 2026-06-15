# agent-bridge

[English](./README.en.md)

将本地 AI 编程助手（Claude Code、Codex 等）桥接到飞书/Lark，支持守护进程多会话管理。

在本地终端使用 Claude Code 编程，所有对话自动同步到飞书话题群 — 也可以直接在飞书端回复来操控 Agent。

## 前置条件

- Node.js >= 20
- 一个飞书/Lark 自建应用，需开启机器人和消息权限（[创建应用](https://open.feishu.cn/app)）

## 安装

```bash
npm i -g @ken-chy129/agent-bridge
```

或直接运行（无需安装）：

```bash
npx @ken-chy129/agent-bridge
```

## 快速开始

### 1. 配置飞书应用

```bash
agent-bridge config
```

扫码授权飞书应用，自动创建话题群。配置保存在 `~/.agent-bridge/config.json`。

也可以手动配置：

```bash
agent-bridge config --chat-id <chatId>        # 直接设置话题群 ID
agent-bridge config --create-group "My Group"  # 创建新话题群
agent-bridge config --reset                    # 重新运行配置向导
```

### 2. 启动会话

**交互模式** — 启动 Claude Code 并同步到飞书：

```bash
agent-bridge chat -d /path/to/project
```

参数说明：

| 参数 | 说明 |
|------|------|
| `-d, --dir <path>` | 工作目录 |
| `-m, --model <model>` | 指定模型 |
| `-r, --resume <id>` | 通过 ID 恢复会话 |
| `-c, --continue` | 继续最近一次会话 |
| `--no-feishu` | 不连接飞书（纯本地模式） |

**守护进程模式** — 自动桥接所有本地 Claude Code 会话：

```bash
agent-bridge serve -d /path/to/default/dir
```

安装全局 `SessionStart` hook，你在任意终端启动的 Claude Code 会话都会被自动发现并桥接到飞书。飞书端也可以直接发消息发起新会话。

### 3. 辅助命令

```bash
agent-bridge discover            # 列出所有活跃的 Claude Code 会话
agent-bridge relay <sessionId>   # 将已有会话桥接到飞书
```

## 工作原理

```
终端 (Claude Code)  ←→  agent-bridge  ←→  飞书话题群
       ↑                      ↑                  ↑
   本地 Agent           JSONL 扫描器 +        卡片消息
   stdin/stdout        SDK resume API        话题内回复
```

- **本地 → 飞书**：实时监听 Claude Code 的 JSONL 输出，将 assistant/tool 消息渲染为飞书交互卡片。
- **飞书 → 本地**：飞书端的回复通过 Claude Agent SDK resume API 注入到 Claude 会话中。
- **守护模式**：hook server 监听 `SessionStart` 事件，自动发现新会话。

## License

MIT
