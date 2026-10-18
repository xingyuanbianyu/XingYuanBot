import lib from './xy-bot/lib.cjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import yaml from 'yaml';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
import { loadPlugins } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');
const configPath = join(__dirname, 'xy-config', 'config.yaml');

// 全局缓存 ws 连接
globalThis._ws = null;

// 消息去重缓存
const processedMessages = new Set();
const MAX_CACHE_SIZE = 2000;

// ========================
// 🌟 全局配置
// ========================
let cmdConfig = {
  enable: true,
  prefixes: ['#', '/']
};

let whitelistConfig = {
  enable: false,
  list: []
};

function loadCmdConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const content = yaml.parse(fs.readFileSync(configPath, 'utf8')) || {};
      
      // 1. 加载前缀配置
      if (content.command_prefix) {
        cmdConfig.enable = content.command_prefix.enable !== false;
        if (Array.isArray(content.command_prefix.prefixes)) {
          cmdConfig.prefixes = content.command_prefix.prefixes;
        }
      }

      // 2. 加载白名单配置
      if (content.whitelist) {
        whitelistConfig.enable = content.whitelist.enable === true;
        if (Array.isArray(content.whitelist.list)) {
          whitelistConfig.list = content.whitelist.list.map(String);
        }
      }
    }
    globalThis.print(`⚙️ [配置] 指令前缀已重载: 启用=${cmdConfig.enable}, 前缀=${JSON.stringify(cmdConfig.prefixes)}`);
    globalThis.print(`⚙️ [配置] 白名单已重载: 启用=${whitelistConfig.enable}, 包含 ${whitelistConfig.list.length} 个特权指令`);
  } catch (e) {
    globalThis.print(`⚠ [配置] 读取配置失败，使用默认配置: ${e.message}`);
  }
}

// 监听配置文件变化，实现热更新
function watchConfig() {
  try {
    fs.watch(configPath, (eventType) => {
      if (eventType === 'change') {
        setTimeout(() => {
          globalThis.print(`🔄 [配置] 检测到 config.yaml 变动，正在热重载...`);
          loadCmdConfig();
        }, 150);
      }
    });
  } catch (e) {
    globalThis.print(`⚠ [配置] 无法监听配置文件，热更新功能失效: ${e.message}`);
  }
}

// ========================
// 全局消息发送器
// ========================
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

// 🌟 核心分发：带白名单特权与前缀剥离
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

  let matchText = (msg.pureText || "").trim();
  if (!matchText) return false;

  let finalPureText = matchText;
  let hasValidPrefix = false;

  // 1. 尝试剥离前缀
  for (const p of cmdConfig.prefixes) {
    if (matchText.startsWith(p)) {
      hasValidPrefix = true;
      finalPureText = matchText.slice(p.length).trim();
      break;
    }
  }

  // 2. 识别是否为“管理指令”（绝对豁免，不能被白名单劫持）
  const isAdminCmd = /^(启用前缀|禁用前缀|查询前缀|添加前缀|删除前缀|启用指令白名单|禁用指令白名单|查询指令白名单|添加指令白名单|删除指令白名单)/.test(finalPureText);

  let isWhitelisted = false;

  // 3. 白名单特权判定（只有“没带前缀”且“不是管理指令”时，才去匹配白名单）
  if (!hasValidPrefix && !isAdminCmd && whitelistConfig.enable && whitelistConfig.list.length > 0) {
    for (const word of whitelistConfig.list) {
      // 严格匹配：完全等于白名单词，或者以 "@xxx 白名单词" 结尾
      if (finalPureText === word || (finalPureText.endsWith(word) && finalPureText.replace(word, '').trim().startsWith('@'))) {
        isWhitelisted = true;
        finalPureText = word; // 把最终文本强行设为白名单词，方便插件精准匹配
        break;
      }
    }
  }

  // 4. 前缀强拦截：
  // 如果开启了前缀限制，而且（没带前缀 且 不是管理指令 且 不是白名单），直接滚蛋
  if (cmdConfig.enable && !hasValidPrefix && !isAdminCmd && !isWhitelisted) {
    return false; 
  }

  if (!finalPureText) return false;

  // 5. 匹配阶段
  if (matchFn) {
    try {
      const isMatched = matchFn(finalPureText); 
      if (!isMatched) return false; 
    } catch (e) {
      console.error(`❌ [插件 ${raw.name || plugin.name || '未知'}] match 异常:`, e.message);
      return false;
    }
  }

  // 6. 执行阶段
  const pluginMsg = {
    ...msg.rawData,        
    content: msg.content,               
    text: msg.message || [],            
    pureText: finalPureText, // 🌟 插件拿到的永远是最干净的指令
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

  loadCmdConfig();
  watchConfig();

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

        let stdMsg = null;
        for (const adapter of registry.list.values()) {
          if (typeof adapter.match === 'function' && adapter.match(parsed)) {
            stdMsg = adapter.toStandard(parsed); 
            break;
          }
        }

        if (!stdMsg) return;

        if (parsed.post_type === 'message' && parsed.message_id) {
          const msgId = String(parsed.message_id);
          if (processedMessages.has(msgId)) return;
          processedMessages.add(msgId);
          if (processedMessages.size > MAX_CACHE_SIZE) processedMessages.clear();
        }

        for (const adapter of registry.list.values()) {
          if (typeof adapter.onRawMessage === 'function') {
            adapter.onRawMessage(parsed, ws);
          }
        }

        if (parsed.post_type === 'message' || parsed.post_type === 'message_sent') {
          
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