import './xy-bot/lib.cjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
import { PluginLoader } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');
const pluginsDir = join(__dirname, 'xy-plugins');

// ================= 框架职责：统一日志 =================
function log(std) {
  const dir = std.type === 'send' ? '发' : '收';
  const kind = std.chatType === 'group' ? '群聊' : '私聊';
  const who = std.type === 'send' ? '' : ` ${std.senderName}:`;
  const body = std.content.substring(0, 30);
  print(`[${dir}] [${kind}] [${std.chatName}]${who} ${body}`);
}

// ================= 框架职责：插件分发与适配回写 =================
function dispatch(std, plugins, adapter, ws) {
  // 核心映射：把新框架的 std 转换成旧插件需要的格式
  const msg = {
    text: std.content,                 // 字符串，match 用
    textSegments: std.messageSegments, // 数组，group-plugin handle 拿 @ 用
    chatId: std.chatId,
    isGroup: std.chatType === 'group',
    senderName: std.senderName,
    senderQQ: std.senderQQ,
    role: std.role ?? 'member',

    msg: std.raw,
    messageId: std.messageId,

    // 指令/index.js 暴力提取 QQ 号需要的别名字段
    user_id: std.senderQQ,
    userId: std.senderQQ,
    qq: std.senderQQ,
    sender: { user_id: std.senderQQ }
  };

  for (const plugin of plugins) {
    const raw = plugin.handler;
    if (!raw) continue;

    let matchFn = null;
    let handleFn = null;

    if (typeof raw === 'function') {
      handleFn = raw;
    } else if (typeof raw === 'object' && raw !== null) {
      if (typeof raw.match === 'function') matchFn = raw.match.bind(raw);
      if (typeof raw.handle === 'function') handleFn = raw.handle.bind(raw);
    }
    if (!handleFn) continue;

    // 匹配检测：只传字符串！所有旧插件的 match 都只收 text
    if (matchFn) {
      try {
        if (!matchFn(msg.text)) continue;
      } catch { continue; }
    }

    // 执行处理：传完整对象
    const name = raw.name || raw.constructor?.name || plugin.name;
    Promise.resolve(handleFn(msg))
        .then((reply) => {
          if (!reply) return;
          const packet = adapter.fromStandard(reply, std);
          if (!packet) return;
          ws.send(JSON.stringify({ ...packet, echo: Date.now() }));
        })
        .catch((e) => {
          print(`[插件报错] ${name}:`, e.message);
          console.error(e);
        });
  }
}

async function main() {
  console.log('🚀 XingYuanBot 启动中...\n');

  const netConfigs = loadNetworkConfig(dataDir);
  if (netConfigs.length === 0) {
    print('⚠ 未在 xy-data 中找到 bot_server.yaml 或 bot_client.yaml');
    return;
  }

  const registry = new AdapterRegistry();
  await registry.scan(join(__dirname, 'adapter', 'adapters'));
  // 从 registry 中取出适配器实例（启动时就有了）
  const adapters = [...registry.list.values()];
  const adapter = adapters.find(a => a.platform === 'qq') || adapters[0];

  const loader = new PluginLoader(pluginsDir, adapter);
  const plugins = await loader.load('qq');
  print(`✅ 已加载 ${plugins.length} 个插件\n`);

  await startNetwork(
      netConfigs,
      (rawData, ws) => {
        try {
          const parsed = JSON.parse(rawData);
          // 过滤元事件和回包
          if (parsed.post_type === 'meta_event' || parsed.echo !== undefined) return;

          // ① 寻找认识该协议包的适配器
          const adapter = [...registry.list.values()].find(a => a.match?.(parsed));
          if (!adapter) return;
          adapter.conn = {ws};

          // 👇 如果是 notice 消息（入群/退群），交给适配器处理并直接结束
          if (parsed.post_type === 'notice') {
            adapter.handleNotice(parsed);
            return;  // 注意这里必须 return，不能让它继续往下走到 toStandard
          }

          // ② 适配器翻译：平台包 -> 标准消息
          const std = adapter.toStandard(parsed);
          if (!std) return;

          // ③ 框架统一打印日志（与平台无关）
          log(std);

          // ④ 框架分发：仅对“接收”的消息进行插件分发
          if (std.type === 'receive') {
            dispatch(std, plugins, adapter, ws);
          }
        } catch (e) {
          // 忽略非 JSON 或解析异常
        }
      },
      (err) => print('⚠ [网络错误]', err.message)
  );

  print('\n✅ 启动完成，已就绪。\n');
  startBot();
}

main().catch(e => {
  print('💥 启动失败:', e.message);
  process.exit(1);
});
