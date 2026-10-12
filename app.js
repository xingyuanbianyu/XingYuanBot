import lib from './xy-bot/lib.cjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
import { loadPlugins } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');

// 全局缓存 ws 连接
globalThis._ws = null;

// 消息去重缓存
const processedMessages = new Set();
const MAX_CACHE_SIZE = 2000;

globalThis.bot = {
  send: async (msg) => {
    const ws = globalThis._ws;
    if (!ws || ws.readyState !== 1) {
      globalThis.print('⚠ bot.send: 无可用连接');
      return;
    }

    const target = msg.isGroup
      ? { message_type: 'group', group_id: msg.chatId }
      : { message_type: 'private', user_id: msg.chatId };

    // 图片消息
    if (msg.file) {
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
      globalThis.print(`[发送图片] -> ${msg.chatId}`);
      return;
    }

    // 文本消息
    if (msg.content) {
      const onebotMsg = {
        action: 'send_msg',
        params: {
          ...target,
          message: [{ type: 'text', data: { text: msg.content } }]
        },
        echo: Date.now()
      };
      ws.send(JSON.stringify(onebotMsg));
      globalThis.print(`[发送文本] -> ${msg.chatId}: ${msg.content}`);
    }
  }
};

// 🌟 核心修复：runPlugin 严格执行 match 过滤，并正确转发适配器的数据
async function runPlugin(plugin, msg) {
  const raw = plugin.handler;
  if (!raw) return false;

  let matchFn = null;
  let handleFn = null;

  if (typeof raw === 'function') {
    handleFn = raw;
  } else if (typeof raw === 'object' && raw !== null) {
    if (typeof raw.match === 'function') matchFn = raw.match.bind(raw);
    if (typeof raw.handle === 'function') handleFn = raw.handle.bind(raw);
  }

  if (!handleFn) return false;

  // 1. 匹配阶段：严格使用适配器给的 pureText！
  if (matchFn) {
    const matchText = msg.pureText || msg.content || '';
    if (!matchText) return false;

    try {
      const isMatched = matchFn(matchText); 
      if (!isMatched) return false; 
    } catch (e) {
      console.error(`❌ [插件 ${raw.name || plugin.name || '未知'}] match 异常:`, e.message);
      return false;
    }
  }

  // 2. 执行阶段：构建包含完整数据结构的 pluginMsg
  const pluginMsg = {
    ...msg.rawData,        
    content: msg.content,               
    text: msg.message || [],            
    pureText: msg.pureText,             
    raw_message: msg.raw_message,
    
    user_id: msg.senderQQ,
    senderId: msg.senderQQ,
    senderQQ: msg.senderQQ,
    senderName: msg.senderName,
    sender: msg.sender,
    
    group_id: msg.isGroup ? msg.chatId : undefined,
    chatId: msg.chatId,
    isGroup: msg.isGroup,
    message_type: msg.message_type,
    
    role: msg.role || 'member'
  };

  try {
    const result = await handleFn(pluginMsg);
    
    if (!result) return false;

    if (typeof result === 'string') {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result });
      return true; 
    } else if (result.file) {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, file: result.file });
      return true;
    } else if (result.content) {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result.content });
      return true;
    } else if (result.message) {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result.message });
      return true;
    }
    return false;
  } catch (e) {
    globalThis.print(`[插件报错] ${plugin.name}: ${e.message}`);
    return false;
  }
}

async function main() {
  await lib(); 

  console.log('🚀 XingYuanBot 启动中...\n');

  const netConfigs = loadNetworkConfig(dataDir);
  if (netConfigs.length === 0) {
    globalThis.print('⚠ 未在 xy-data 中找到 bot_server.yaml 或 bot_client.yaml');
    return;
  }

  const registry = new AdapterRegistry();
  await registry.scan(join(__dirname, 'adapter', 'adapters'));

  const { plugins, errors } = await loadPlugins(registry);

  globalThis.print(`\n✅ 已成功加载 ${plugins.length} 个插件\n`);
  
  if (errors && errors.length > 0) {
    globalThis.print('⚠ 发现以下加载异常:');
    for (const err of errors) {
      globalThis.print(`   - ${err}`);
    }
  }

  const connections = await startNetwork(
    netConfigs,
    async (rawData, ws) => {
      globalThis._ws = ws;

      try {
        const parsed = JSON.parse(rawData);
        if (parsed.post_type === 'meta_event' || parsed.echo !== undefined) return;

        // 🌟 核心修复 1：无条件让适配器处理所有包，包括 notice 事件！
        let stdMsg = null;
        for (const adapter of registry.list.values()) {
          if (typeof adapter.match === 'function' && adapter.match(parsed)) {
            // 注意：如果是 notice，toStandard 内部会调用 handleNotice 触发事件，并返回 null
            stdMsg = adapter.toStandard(parsed); 
            break;
          }
        }

        // 如果适配器返回 null（说明是 notice 事件，或者不认识的包），直接结束流程！
        if (!stdMsg) return;

        // 🌟 核心修复 2：消息去重（只针对 message，notice 没 message_id 不拦截）
        if (parsed.post_type === 'message' && parsed.message_id) {
          const msgId = String(parsed.message_id);
          if (processedMessages.has(msgId)) return;
          processedMessages.add(msgId);
          if (processedMessages.size > MAX_CACHE_SIZE) processedMessages.clear();
        }

        // 触发适配器的原始消息钩子
        for (const adapter of registry.list.values()) {
          if (typeof adapter.onRawMessage === 'function') {
            adapter.onRawMessage(parsed, ws);
          }
        }

        // 只处理消息类型
        if (parsed.post_type === 'message' || parsed.post_type === 'message_sent') {
          
          // 日志打印（使用适配器内容）
          const isSend = parsed.post_type === 'message_sent';
          let displayContent = stdMsg.content || '';
          displayContent = displayContent.substring(0, 30);

          if (stdMsg.chatType === 'group') {
            if (isSend) globalThis.print(`[发] [群聊] [${stdMsg.chatName}] ${displayContent}`);
            else globalThis.print(`[收] [群聊] [${stdMsg.chatName}] ${stdMsg.senderName}: ${displayContent}`);
          } else {
            if (isSend) globalThis.print(`[发] [私聊] ${displayContent}`);
            else globalThis.print(`[收] [私聊] ${stdMsg.senderName}: ${displayContent}`);
          }

          // 只有“收到”的消息才需要执行插件逻辑
          if (parsed.post_type === 'message') {
            const msg = {
              type: 'receive',
              post_type: parsed.post_type,
              message_type: stdMsg.chatType === 'group' ? 'group' : 'private',
              isGroup: stdMsg.chatType === 'group',
              
              chatId: stdMsg.chatId,          
              senderQQ: stdMsg.senderId,      
              senderName: stdMsg.senderName,  
              sender: stdMsg.sender || { user_id: stdMsg.senderId, nickname: stdMsg.senderName },
              role: stdMsg.role || 'member',
              
              pureText: stdMsg.pureText,       
              content: stdMsg.content,         
              message: stdMsg.messageSegments, 
              raw_message: parsed.raw_message,
              rawData: parsed
            };

            // 遍历并执行插件
            for (const plugin of plugins) {
              if (plugin && plugin.handler) {
                const handled = await runPlugin(plugin, msg);
                if (handled) {
                  break; 
                }
              }
            }
          }
        }
      } catch (e) {
        // 忽略非 JSON 数据
      }
    },
    (err) => globalThis.print(`⚠ [网络错误] ${err.message}`)
  );

  registry.mountNetwork(connections);
  globalThis.print('\n✅ 启动完成，已就绪。\n');

  startBot();
}

main().catch(e => {
  globalThis.print(`💥 启动失败: ${e.message}`);
  process.exit(1);
});