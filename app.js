// app.js
// 1. 导入我们的混合加载器（默认导出是一个 async 函数）
import lib from './xy-bot/lib.cjs';

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
import { loadPlugins } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';
import { normalizeMessage } from './xy-bot/message.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');

// 全局缓存 ws 连接
globalThis._ws = null;

// ========================
// 统一发送器（回调层）
// ========================
globalThis.bot = {
  send: async (msg) => {
    const ws = globalThis._ws;
    if (!ws || ws.readyState !== 1) {
      print('⚠ bot.send: 无可用连接');
      return;
    }

    const target = msg.isGroup
      ? { message_type: 'group', group_id: msg.chatId }
      : { message_type: 'private', user_id: msg.chatId };

    // 图片消息
    if (msg.file && Buffer.isBuffer(msg.file)) {
      const base64 = msg.file.toString('base64');
      const onebotMsg = {
        action: 'send_msg',
        params: {
          ...target,
          message: [{ type: 'image', data: { file: `base64://${base64}` } }]
        },
        echo: Date.now()
      };
      ws.send(JSON.stringify(onebotMsg));
      print(`[发送图片] -> ${msg.chatId}`);
      return;
    }

    // 文本消息
    if (msg.content) {
      const onebotMsg = {
        action: 'send_msg',
        params: {
          ...target,
          message: [{ type: 'text', data: { text: String(msg.content) } }]
        },
        echo: Date.now()
      };
      ws.send(JSON.stringify(onebotMsg));
      print(`[发送文本] -> ${msg.chatId}: ${msg.content}`);
    }
  }
};

// ========================
// 插件执行器（处理 + 回调）
// ========================
async function runPlugin(plugin, msg) {
  const raw = plugin.handler;
  if (!raw) return false;

  let handleFn = null;

  if (typeof raw === 'function') {
    handleFn = raw;
  } else if (typeof raw === 'object' && raw !== null) {
    if (typeof raw.handle === 'function') handleFn = raw.handle.bind(raw);
  }

  if (!handleFn) return false;

  const pluginMsg = {
    ...msg,
    role: msg.role || 'member',
  };

  try {
    const result = await handleFn(pluginMsg);
    
    if (!result) return false;

    // 兼容多种返回格式
    if (typeof result === 'string') {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result });
      return true;
    } else if (result.file && Buffer.isBuffer(result.file)) {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, file: result.file });
      return true;
    } else if (result.content) {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result.content });
      return true;
    } else if (result.message) {  // 支持 { type: 'reply', message: '...' }
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result.message });
      return true;
    }
    
    return false;
  } catch (e) {
    print(`[插件报错] ${plugin.name}: ${e.message}`);
    return false;
  }
}

// ========================
// 主流程
// ========================
async function main() {
  console.log('🚀 XingYuanBot 启动中...\n');

  // 🌟 核心改动：一句话全量同步+异步混合加载！
  // 内部对 .cjs/.js 走同步 require，对 .mjs 走 await import，
  // 整个函数 await 完毕后，所有 globalThis 工具（print、writeLog、parseMsg等）全部就绪！
  await lib();

  const netConfigs = loadNetworkConfig(dataDir);
  if (netConfigs.length === 0) {
    print('⚠ 未在 xy-data 中找到 bot_server.yaml 或 bot_client.yaml');
    return;
  }

  const registry = new AdapterRegistry();
  await registry.scan(join(__dirname, 'adapter', 'adapters'));

  const { plugins, errors } = await loadPlugins();

  print(`\n✅ 已成功加载 ${plugins.length} 个插件\n`);

  if (errors && errors.length > 0) {
    print('⚠ 发现以下加载异常:');
    for (const err of errors) {
      print(`   - ${err}`);
    }
  }

  // ========================
  // 网络消息入口
  // ========================
  const connections = await startNetwork(
    netConfigs,
    async (rawData, ws) => {
      globalThis._ws = ws;

      let parsed;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        return; // 非 JSON，忽略
      }

      if (parsed.post_type === 'meta_event' || parsed.echo !== undefined) return;

      // ==== 通知所有适配器 ====
      for (const adapter of registry.list.values()) {
        if (typeof adapter.onRawMessage === 'function') {
          try { adapter.onRawMessage(parsed, ws); } catch (e) { /* ignore */ }
        }
      }

      if (parsed.post_type !== 'message') return;

      // 🌟 标准化消息
      const msg = normalizeMessage(parsed);
      if (!msg || msg.type !== 'message') return;

      // ==== 日志打印 ====
      const tag = msg.isGroup ? '群聊' : '私聊';
      const chat = msg.chatName || msg.chatId;
      const preview = (msg.content || '').substring(0, 30);
      print(`[收] [${tag}] [${chat}] ${msg.senderName}: ${preview}`);

      // ==== 分发给所有插件 ====
      for (const plugin of plugins) {
        if (plugin && plugin.handler) {
          const handled = await runPlugin(plugin, msg);
          if (handled) {
            break; // 🎯 一旦有人处理，立刻中断，防止重复回复
          }
        }
      }
    },
    (err) => print(`⚠ [网络错误] ${err.message}`)
  );

  registry.mountNetwork(connections);
  print('\n✅ 启动完成，已就绪。\n');

  startBot();
}

main().catch(e => {
  print(`💥 启动失败: ${e.message}`);
  process.exit(1);
});