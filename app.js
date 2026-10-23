import lib from './xy-bot/lib.cjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import yaml from 'yaml';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
// 🌟 引入 clearPluginCache 和 hotReloadPlugin
import { loadPlugins, clearPluginCache, hotReloadPlugin } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';

import { isQQAllowed, isGroupAllowed } from './xy-bot/config.js';
import { getRole } from './xy-config/config/permissions.js';

import { startWebPanel } from './web-panel.js';

// 🌟 全局日志兜底
globalThis.print = globalThis.print || console.log;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');
const configPath = join(__dirname, 'xy-config', 'config.yaml');
const priorityPath = join(__dirname, 'xy-config', 'priority.yaml'); 
const ownerFilePath = join(__dirname, 'xy-data', 'owner.json'); // 号主记录文件

// 🌟 共享状态
const sharedState = {
    wsPool: new Map(),
    wsToBotId: new Map(),
    botIdToWs: new Map(),
    instances: new Map(),
    ownerQQ: null // 全局记录号主
};

// 读取号主记录
if (fs.existsSync(ownerFilePath)) {
    try {
        const data = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8'));
        sharedState.ownerQQ = data.ownerQQ || null;
    } catch (e) {}
}

globalThis._ws = null; 
globalThis.botInfo = { qq: '10000' };

let processedMessages = [];
const MAX_CACHE_SIZE = 2000;
const interactiveSessions = new Map();
// 🌟 核心修复：暴露给全局，让验证插件能往里面塞人！
globalThis._interactiveSessions = interactiveSessions; 

let cmdConfig = { enable: true, prefixes: ['#', '/'] };
let whitelistConfig = { enable: false, list: [] };
let priorityPlugins = new Set(); 

// ==================== 1. 消息发送 ====================
// 底层安全发送函数
function safeSend(ws, data) {
    if (ws && ws.readyState === 1) {
        try {
            ws.send(JSON.stringify(data));
            return true;
        } catch (e) {
            globalThis.print(`⚠️ [发送异常] ${e.message}`);
            return false;
        }
    }
    return false;
}

// 挂载全局 Bot 发送器
globalThis.bot = {
  send: async (msg) => {
    let targetWs = null;
    
    // 优先通过 botId 找对应的连接
    if (msg.botId) targetWs = sharedState.botIdToWs.get(String(msg.botId));
    // 其次使用消息自带的 ws
    if (!targetWs && msg._ws) targetWs = msg._ws;
    // 🌟 兜底：使用全局当前活跃的 ws (配合 network.js 新增的 globalThis.activeWs)
    if (!targetWs) targetWs = globalThis.activeWs || globalThis._ws;

    if (!targetWs || targetWs.readyState !== 1) {
        globalThis.print('⚠️ [发送失败] WebSocket 未连接');
        return;
    }

    const target = msg.isGroup
      ? { message_type: 'group', group_id: msg.chatId }
      : { message_type: 'private', user_id: msg.chatId };

    // 发送图片
    if (msg.file) {
      const base64 = msg.file.toString('base64');
      safeSend(targetWs, {
          action: 'send_msg', 
          params: { ...target, message: [{ type: 'image', data: { file: `base64://${base64}` } }] }, 
          echo: Date.now() 
      });
      return;
    }

    // 发送文本
    if (msg.content) {
      safeSend(targetWs, {
          action: 'send_msg', 
          params: { ...target, message: [{ type: 'text', data: { text: msg.content } }] }, 
          echo: Date.now() 
      });
    }
  }
};

// ==================== 2. 插件执行逻辑 ====================
async function runPlugin(plugin, msg) {
  const raw = plugin.handler;
  if (!raw) return false;

  let matchFn = null;
  let handleFn = null;

  if (typeof raw === 'function') handleFn = raw;
  else if (typeof raw === 'object' && raw !== null) {
    if (typeof raw.match === 'function') matchFn = raw.match.bind(raw);
    if (typeof raw.handle === 'function') handleFn = raw.handle.bind(raw);
  }

  if (!handleFn) return false;

  const pluginName = raw.name || plugin.name || '未知';
  const isPriority = priorityPlugins.has(pluginName);

  // 处理交互式会话拦截
  const session = interactiveSessions.get(msg.senderQQ);
  if (session && session.expireAt > Date.now() && !isPriority) {
      if (session.pluginName === pluginName) {
          try {
              const result = await handleFn(msg);
              if (result) {
                  const content = typeof result === 'string' ? result : (result.content || result.message);
                  if (content) globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content, botId: msg.botId, _ws: msg._ws });
                  if (result && typeof result === 'object' && result.__interceptNext === false) {
                      interactiveSessions.delete(msg.senderQQ);
                  }
                  return true;
              }
          } catch (e) { 
              interactiveSessions.delete(msg.senderQQ); 
              globalThis.print(`[插件异常] ${pluginName} 交互模式报错: ${e.message}`);
          }
          return true; 
      }
  }

  let matchText = (msg.pureText || "").trim();
  let finalPureText = matchText; 

  // 处理指令前缀和白名单
  if (!isPriority) {
      let hasValidPrefix = false;

      for (const p of cmdConfig.prefixes) {
        if (matchText.startsWith(p)) {
          hasValidPrefix = true;
          finalPureText = matchText.slice(p.length).trim(); 
          break;
        }
      }

      const isAdminCmd = /^(启用前缀|禁用前缀|查询前缀|添加前缀|删除前缀|启用指令白名单|禁用指令白名单|查询指令白名单|添加指令白名单|删除指令白名单)/.test(finalPureText);
      let isWhitelisted = false;

      if (!hasValidPrefix && !isAdminCmd && whitelistConfig.enable && whitelistConfig.list.length > 0) {
        for (const word of whitelistConfig.list) {
          if (matchText === word) {
            isWhitelisted = true;
            break;
          }
        }
      }

      if (cmdConfig.enable && !hasValidPrefix && !isAdminCmd && !isWhitelisted && matchText) {
          return false;
      }

      if (matchFn) {
        try {
          if (!matchFn(finalPureText)) return false; 
        } catch (e) { return false; }
      }
  }

  const pluginMsg = {
    ...msg,               
    ...msg.rawData,       
    content: msg.content,               
    text: msg.message || [],            
    pureText: finalPureText, 
    raw_message: msg.raw_message,
    botId: msg.botId, 
    _ws: msg._ws
  };

  try {
    const result = await handleFn(pluginMsg);
    
    if (!result) return false;

    if (result && typeof result === 'object' && result.__interceptNext === true) {
        interactiveSessions.set(msg.senderQQ, { pluginName: pluginName, expireAt: Date.now() + 3 * 60 * 1000 });
    }

    if (typeof result === 'string') {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result, botId: msg.botId, _ws: msg._ws });
      return true; 
    } else if (result.file) {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, file: result.file, botId: msg.botId, _ws: msg._ws });
      return true;
    } else if (result.content || result.message) {
      globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result.content || result.message, botId: msg.botId, _ws: msg._ws });
      return true;
    }
    return false;
  } catch (e) {
    globalThis.print(`[插件报错] ${pluginName}: ${e.message}`);
    return false;
  }
}

// ==================== 3. 核心消息处理 ====================
async function handleIncomingMessage(rawData, ws, registry, plugins) {
    if (!ws || ws.readyState !== 1) return;

    if (!sharedState.wsPool.has(ws)) {
      sharedState.wsPool.set(ws, { connectedAt: Date.now() });
      globalThis._ws = ws; 
      globalThis.activeWs = ws; // 确保给 wsCall 兜底
    }

    try {
        const parsed = JSON.parse(rawData);
        
        // 过滤心跳包和 API 回执 (network.js 已经拦截了 API 回执，这里再兜底一次)
        if (parsed.post_type === 'meta_event' || parsed.echo !== undefined) return;

        // 动态绑定 Bot ID 和 WS 连接
        if (parsed.self_id) {
            const botId = String(parsed.self_id);
            globalThis.botInfo.qq = botId; 
            if (!sharedState.wsToBotId.has(ws)) {
                sharedState.wsToBotId.set(ws, botId);
                sharedState.botIdToWs.set(botId, ws);
                globalThis.print(`🔗 [路由] 动态绑定连接成功，Bot QQ: ${botId}`);
                
                // 🌟 记录号主 QQ
                if (sharedState.ownerQQ !== botId) {
                    sharedState.ownerQQ = botId;
                    fs.writeFileSync(ownerFilePath, JSON.stringify({ ownerQQ: botId, updateAt: Date.now() }, null, 2));
                    globalThis.print(`👑 [系统] 已将 ${botId} 记录为号主！`);
                }
            }
        }

        // 交给适配器转换为标准格式
        let stdMsg = null;
        for (const adapter of registry.list.values()) {
          if (typeof adapter.match === 'function' && adapter.match(parsed)) {
            stdMsg = adapter.toStandard(parsed); 
            break;
          }
        }
        
        if (!stdMsg) return;

        // 处理消息事件
        if (parsed.post_type === 'message') {
          const senderQQ = stdMsg.senderId;
          const chatId = stdMsg.chatId;
          const isGroup = stdMsg.chatType === 'group';
          
          let userRole = 'member';
          try {
             userRole = getRole(senderQQ);
          } catch(e) {}

          // 号主直接放行，不受黑白名单限制
          if (userRole !== 'master' && userRole !== 'owner' && senderQQ !== sharedState.ownerQQ) {
              if (isGroup && !isGroupAllowed(chatId)) return;
              if (!isQQAllowed(senderQQ)) return;
          }

          // 消息去重
          if (parsed.message_id) {
            const msgId = `${stdMsg.selfId}_${parsed.message_id}_${stdMsg.senderId}`;
            if (processedMessages.includes(msgId)) return;
            processedMessages.push(msgId);
            if (processedMessages.length > MAX_CACHE_SIZE) processedMessages.shift();
          }

          // 构建标准统一消息对象
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
            rawData: parsed,
            botId: stdMsg.selfId ? String(stdMsg.selfId) : null,
            _ws: ws 
          };

          // 分发给所有插件
          for (const plugin of plugins) {
            if (plugin && plugin.handler) {
              const handled = await runPlugin(plugin, msg);
              const pluginName = plugin.handler.name || plugin.name || '未知';
              const isPriority = priorityPlugins.has(pluginName);
              if (handled && !isPriority) break; 
            }
          }
        }
    } catch (e) { globalThis.print(`[处理异常] ${e.message}`); }
}

// ==================== 4. 配置加载 ====================
function loadCmdConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const content = yaml.parse(fs.readFileSync(configPath, 'utf8')) || {};
      if (content.command_prefix) {
        cmdConfig.enable = content.command_prefix.enable !== false;
        if (Array.isArray(content.command_prefix.prefixes)) {
          cmdConfig.prefixes = content.command_prefix.prefixes;
        }
      }
      if (content.whitelist) {
        whitelistConfig.enable = content.whitelist.enable === true;
        if (Array.isArray(content.whitelist.list)) {
          whitelistConfig.list = content.whitelist.list.map(String);
        }
      }
    }
    
    if (fs.existsSync(priorityPath)) {
        const pContent = yaml.parse(fs.readFileSync(priorityPath, 'utf8')) || {};
        if (Array.isArray(pContent.priority_plugins)) {
            priorityPlugins = new Set(pContent.priority_plugins.map(String));
        }
    } else {
        priorityPlugins = new Set();
    }
  } catch (e) {
    globalThis.print(`⚠️ [配置加载失败] ${e.message}`);
  }
}

function watchConfig() {
  try {
    if (fs.existsSync(configPath)) {
        fs.watch(configPath, (eventType) => {
          if (eventType === 'change') setTimeout(() => { loadCmdConfig(); }, 150);
        });
    }
    if (fs.existsSync(priorityPath)) {
        fs.watch(priorityPath, (eventType) => {
          if (eventType === 'change') setTimeout(() => { loadCmdConfig(); }, 150);
        });
    }
  } catch (e) {}
}

// ==================== 5. 启动主流程 ====================
async function main() {
  await lib(); 
  console.log('🚀 XingYuanBot 启动中...\n');

  loadCmdConfig();
  watchConfig();

  // 定时清理过期的交互会话
  setInterval(() => {
      const now = Date.now();
      for (const [qq, sess] of interactiveSessions) {
          if (sess.expireAt <= now) interactiveSessions.delete(qq);
      }
  }, 60000);

  // 1. 初始化网络配置
  const netConfigs = loadNetworkConfig(dataDir);
  
  // 2. 初始化适配器
  const registry = new AdapterRegistry();
  await registry.scan(join(__dirname, 'adapter', 'adapters'));

  // 3. 加载所有插件
  const { plugins, errors } = await loadPlugins(registry);
  globalThis.print(`\n✅ 已成功加载 ${plugins.length} 个插件\n`);
  if (errors && errors.length > 0) {
      globalThis.print(`⚠️ 插件加载时产生 ${errors.length} 个错误，请检查。`);
  }

  // 4. 暴露给全局，供插件和定时器使用
  globalThis.handleIncomingMessage = handleIncomingMessage;
  globalThis._registry = registry;
  globalThis._plugins = plugins;

  // 🌟 5. 核心挂载：让指令插件的“重载”功能生效
  globalThis._xyReloadPlugins = async (pluginName) => {
      try {
          if (pluginName && typeof hotReloadPlugin === 'function') {
              // 单插件热重载
              await hotReloadPlugin(pluginName, registry);
              return [pluginName];
          } else {
              // 全量重载
              if (typeof clearPluginCache === 'function') clearPluginCache();
              const result = await loadPlugins(registry);
              // 必须更新全局的插件数组，否则主分发逻辑用的还是旧数组
              globalThis._plugins = result.plugins;
              return result.plugins;
          }
      } catch (e) {
          globalThis.print(`[重载失败] ${e.message}`);
          return [];
      }
  };

  // 6. 启动网络监听/连接
  if (netConfigs.length > 0) {
      const connections = await startNetwork(
        netConfigs,
        (rawData, ws) => handleIncomingMessage(rawData, ws, registry, plugins),
        (err) => globalThis.print(`⚠ [网络错误] ${err.message}`)
      );
      registry.mountNetwork(connections);
  } else {
      globalThis.print('⚠️ 未找到网络配置文件，跳过网络启动。');
  }

  // 7. 启动 Web 面板
  startWebPanel({
      registry,
      plugins,
      handleIncomingMessage,
      sharedState,
      __dirname
  });

  globalThis.print('\n✅ 主控与网页面板均启动完成。\n');
  
  // 8. 启动终端保活 CLI
  startBot();
}

// 启动！
main().catch(e => {
  globalThis.print(`💥 启动失败: ${e.message}`);
  process.exit(1);
});

// 退出清理
function cleanupAllInstances() {
    globalThis.print('⚠️ 接收到退出信号，正在清理所有子进程...');
    for (const [id, inst] of sharedState.instances) {
        try {
            if (inst.child && !inst.child.killed) {
                inst.child.kill('SIGKILL');
            }
        } catch(e) {}
    }
    process.exit(0);
}

process.on('SIGINT', cleanupAllInstances);
process.on('SIGTERM', cleanupAllInstances);