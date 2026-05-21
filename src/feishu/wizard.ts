import { createInterface } from 'node:readline';
import { registerApp, Client, Domain } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import type { FeishuConfig } from './config';

export async function runSetupWizard(): Promise<FeishuConfig> {
  console.log('\n未检测到飞书应用配置，进入扫码创建向导。\n');

  const result = await registerApp({
    onQRCodeReady: (info) => {
      console.log('请用飞书 App 扫描以下二维码完成应用创建：\n');
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com 域名。');
      }
    },
  });

  const tenant = result.user_info?.tenant_brand === 'lark' ? 'lark' as const : 'feishu' as const;

  console.log('\n✓ 应用创建成功');
  console.log(`  App ID:  ${result.client_id}`);
  console.log(`  Tenant:  ${tenant}`);

  // Choose or create a topic group
  const chatId = await setupTopicGroup({
    appId: result.client_id,
    appSecret: result.client_secret,
    tenant,
  });

  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    tenant,
    chatId,
  };
}

async function setupTopicGroup(opts: {
  appId: string;
  appSecret: string;
  tenant: 'feishu' | 'lark';
}): Promise<string | undefined> {
  const client = new Client({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
  });

  // List groups the bot is in
  console.log('\n正在查找 bot 已加入的群...');
  const groups = await listBotGroups(client);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((r) => rl.question(q, (a) => r(a.trim())));

  try {
    if (groups.length > 0) {
      console.log(`\n找到 ${groups.length} 个群：\n`);
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const mode = g.chat_mode === 'topic' ? '话题' : '普通';
        console.log(`  ${i + 1}) ${g.name}  [${mode}群]  ${g.chat_id}`);
      }
      console.log(`  ${groups.length + 1}) 创建新的话题群`);
      console.log(`  0) 跳过（稍后设置）`);

      const choice = await ask('\n选择群 [1]: ');
      const idx = choice === '' ? 1 : parseInt(choice);

      if (idx === 0) {
        console.log('已跳过。稍后可用 agent-bridge config --chat-id <id> 设置。');
        return undefined;
      }
      if (idx >= 1 && idx <= groups.length) {
        const selected = groups[idx - 1];
        console.log(`\n✓ 已选择: ${selected.name} (${selected.chat_id})`);
        return selected.chat_id;
      }
      if (idx === groups.length + 1) {
        return await createTopicGroup(client, rl);
      }

      console.log('无效选择，已跳过。');
      return undefined;
    } else {
      console.log('\nbot 尚未加入任何群。');
      const create = await ask('是否创建一个话题群？(Y/n): ');
      if (create.toLowerCase() !== 'n') {
        return await createTopicGroup(client, rl);
      }
      console.log('已跳过。你可以在飞书中把 bot 拉入话题群，然后运行 agent-bridge config --chat-id <id>');
      return undefined;
    }
  } finally {
    rl.close();
  }
}

async function createTopicGroup(
  client: Client,
  rl: { question: (q: string, cb: (a: string) => void) => void },
): Promise<string | undefined> {
  const ask = (q: string): Promise<string> =>
    new Promise((r) => rl.question(q, (a) => r(a.trim())));

  const name = (await ask('群名称 [Agent Bridge]: ')) || 'Agent Bridge';

  try {
    const resp = await client.im.v1.chat.create({
      data: {
        name,
        chat_mode: 'topic',
        chat_type: 'private',
      },
    });

    const chatId = (resp as any)?.data?.chat_id;
    if (!chatId) {
      console.error('创建群失败：未返回 chat_id');
      return undefined;
    }

    console.log(`\n✓ 话题群已创建: ${name} (${chatId})`);
    console.log('  请在飞书中找到该群，并邀请需要的成员加入。');
    return chatId;
  } catch (err) {
    console.error(`创建群失败: ${err}`);
    console.log('你可以手动创建话题群后运行 agent-bridge config --chat-id <id>');
    return undefined;
  }
}

interface GroupInfo {
  chat_id: string;
  name: string;
  chat_mode: string;
}

async function listBotGroups(client: Client): Promise<GroupInfo[]> {
  const groups: GroupInfo[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const resp = await client.im.v1.chat.list({
        params: { page_size: 50, page_token: pageToken },
      }) as any;
      const items = resp?.data?.items ?? [];
      for (const item of items) {
        groups.push({
          chat_id: item.chat_id ?? '',
          name: item.name ?? '(unnamed)',
          chat_mode: item.chat_mode ?? 'group',
        });
      }
      pageToken = resp?.data?.page_token;
    } while (pageToken);
  } catch {
    // Bot might not have im:chat scope yet
  }
  return groups;
}
