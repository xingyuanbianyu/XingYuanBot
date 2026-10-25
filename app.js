import lib from './xy-bot/lib.cjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import yaml from 'yaml';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
import { loadPlugins, clearPluginCache, hotReloadPlugin } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';

import { isQQAllowed, isGroupAllowed } from './xy-bot/config.js';
import { getRole } from './xy-config/config/permissions.js';

import { startWebPanel } from './web-panel.js';

globalThis.print = globalThis.print || console.log;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');
const configPath = join(__dirname, 'xy-config', 'config.yaml');
const priorityPath = join(__dirname, 'xy-config', 'priority.yaml'); 
const ownerFilePath = join(__dirname, 'xy-data', 'owner.json'); 

function killPort(port) {
    try {
        if (process.platform === 'win32') {
            const output = execSync(`netstat -ano | findstr :${port}`).toString();
            const lines = output.split('\n');
            const pids = new Set();
            for (const line of lines) {
                if (line.includes('LISTENING')) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && pid !== '0' && !isNaN(pid)) pids.add(pid);
                }
            }
            for (const pid of pids) {
                execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
                globalThis.print(`🔪 [端口清理] Windows: 已结束占用端口 ${port} 的进程 (PID: ${pid})`);
            }
        } else {
            try {
                execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
                globalThis.print(`🔪 [端口清理] Linux: 已结束占用端口 ${port} 的进程`);
            } catch (e) {
                try {
                    execSync(`lsof -t -i:${port} | xargs kill -9`, { stdio: 'ignore' });
                    globalThis.print(`🔪 [端口清理] Unix: 已结束占用端口 ${port} 的进程`);
                } catch (err) {}
            }
        }
    } catch (e) {}
}

const sharedState = {
    wsPool: new Map(),
    wsToBotId: new Map(),
    botIdToWs: new Map(),
    instances: new Map(),
    ownerQQ: null 
};

globalThis._commandAliases = new Map();

// 🌟 终极动态递归寻找 alias.db
function findAliasDb(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            const result = findAliasDb(fullPath);
            if (result) return result;
        } else if (file === 'alias.db') {
            return fullPath;
        }
    }
    return null;
}

async function loadCommandAliases() {
    const pluginBaseDir = join(__dirname, 'xy-plugins');
    const aliasDbPath = findAliasDb(pluginBaseDir);

    if (!aliasDbPath) {
        globalThis.print(`⚠️ [映射缓存] 未在 xy-plugins 目录下找到 alias.db 文件。`);
        return;
    }

    try {
        const db = new Database(aliasDbPath, { readonly: true });
        const rows = db.prepare('SELECT group_id, alias_cmd, original_cmd FROM group_aliases').all();
        db.close();

        globalThis._commandAliases.clear();
        for (const r of rows) {
            globalThis._commandAliases.set(`${r.group_id}_${r.alias_cmd}`, r.original_cmd);
        }
        if (rows.length > 0) {
            globalThis.print(`✅ [映射缓存] 已成功从 ${aliasDbPath} 加载 ${rows.length} 条指令映射规则`);
        }
    } catch (e) {
        globalThis.print(`⚠️ [映射缓存] 加载失败: ${e.message}`);
    }
}

globalThis._groupMembersCache = new Map();

globalThis.getGroupMembers = (groupId) => {
    return globalThis._groupMembersCache.get(String(groupId)) || [];
};

async function updateGroupMembersCache(groupId) {
    if (typeof globalThis.wsCall !== 'function') return;
    const gid = Number(groupId);
    try {
        const res = await globalThis.wsCall('get_group_member_list', { group_id: gid, no_cache: true });
        if (res && res.status === 'ok' && Array.isArray(res.data)) {
            await sleep(500);
            const cleanList = res.data.map(m => ({
                user_id: m.user_id,
                nickname: m.nickname,
                card: m.card || ''
            }));
            await sleep(1000);
            globalThis._groupMembersCache.set(String(gid), cleanList);
            globalThis.print(`🔄 [缓存更新] 群 ${gid} 成员列表已刷新，共 ${cleanList.length} 人。`);
        }
    } catch (e) {
        globalThis.print(`⚠️ [缓存异常] 更新群 ${gid} 成员失败: ${e.message}`);
    }
}

async function initAllGroupMembersCache() {
    if (typeof globalThis.wsCall !== 'function') return;
    try {
        globalThis.print('⏳ [系统] 正在全量拉取所有群成员数据，请稍候...');
        const res = await globalThis.wsCall('get_group_list');
        if (res && res.status === 'ok' && Array.isArray(res.data)) {
            const groups = res.data;
            globalThis.print(`🔍 [系统] 发现 ${groups.length} 个群，开始拉取成员信息...`);
            await sleep(1000);
            
            for (const group of groups) {
                await updateGroupMembersCache(group.group_id);
                await new Promise(r => setTimeout(r, 500)); 
            }
            await sleep(1000);
            globalThis.print('✅ [系统] 所有群成员数据缓存完毕！');
        }
    } catch (e) {
        globalThis.print(`⚠️ [系统] 初始化群成员缓存失败: ${e.message}`);
    }
}

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
globalThis._interactiveSessions = interactiveSessions; 

let cmdConfig = { enable: true, prefixes: ['#', '/'] };
let whitelistConfig = { enable: false, list: [] };
let priorityPlugins = new Set(); 

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

globalThis.bot = {
  send: async (msg) => {
    let targetWs = null;
    if (msg.botId) targetWs = sharedState.botIdToWs.get(String(msg.botId));
    if (!targetWs && msg._ws) targetWs = msg._ws;
    if (!targetWs) targetWs = globalThis.activeWs || globalThis._ws;

    if (!targetWs || targetWs.readyState !== 1) {
        globalThis.print('⚠️ [发送失败] WebSocket 未连接');
        return;
    }

    const target = msg.isGroup
      ? { message_type: 'group', group_id: msg.chatId }
      : { message_type: 'private', user_id: msg.chatId };

    if (msg.file) {
      const base64 = msg.file.toString('base64');
      safeSend(targetWs, {
          action: 'send_msg', 
          params: { ...target, message: [{ type: 'image', data: { file: `base64://${base64}` } }] }, 
          echo: Date.now() 
      });
      return;
    }

    if (msg.content) {
      safeSend(targetWs, {
          action: 'send_msg', 
          params: { ...target, message: [{ type: 'text', data: { text: msg.content } }] }, 
          echo: Date.now() 
      });
    }
  }
};

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

  if (!isPriority) {
      // 🌟 核心放行逻辑：如果是映射指令，直接放行，不管前缀
      if (msg._isMapped) {
          finalPureText = matchText;
      } else {
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

async function handleIncomingMessage(rawData, ws, registry, plugins) {
    if (!ws || ws.readyState !== 1) return;

    if (!sharedState.wsPool.has(ws)) {
        sharedState.wsPool.set(ws, { connectedAt: Date.now() });
        globalThis._ws = ws; 
        globalThis.activeWs = ws;
    }

    try {
        const parsed = JSON.parse(rawData);
        
        if (parsed.post_type === 'meta_event' || parsed.echo !== undefined) return;

        if (parsed.self_id) {
            const botId = String(parsed.self_id);
            globalThis.botInfo.qq = botId; 
            if (!sharedState.wsToBotId.has(ws)) {
                sharedState.wsToBotId.set(ws, botId);
                sharedState.botIdToWs.set(botId, ws);
                globalThis.print(`🔗 [路由] 动态绑定连接成功，Bot QQ: ${botId}`);
                
                if (sharedState.ownerQQ !== botId) {
                    sharedState.ownerQQ = botId;
                    fs.writeFileSync(ownerFilePath, JSON.stringify({ ownerQQ: botId, updateAt: Date.now() }, null, 2));
                    globalThis.print(`👑 [系统] 已将 ${botId} 记录为号主！`);
                    
                    setTimeout(() => initAllGroupMembersCache(), 2000); 
                }
            }
        }

        if (parsed.post_type === 'notice' && ['group_increase', 'group_decrease', 'group_kick', 'group_card'].includes(parsed.notice_type)) {
            if (parsed.group_id) {
                updateGroupMembersCache(parsed.group_id);
            }
        }

        let stdMsg = null;
        for (const adapter of registry.list.values()) {
          if (typeof adapter.match === 'function' && adapter.match(parsed)) {
            stdMsg = adapter.toStandard(parsed); 
            break;
          }
        }
        
        if (!stdMsg) return;

        if (parsed.post_type === 'message') {
          const senderQQ = stdMsg.senderId;
          const chatId = stdMsg.chatId;
          const isGroup = stdMsg.chatType === 'group';
          
          let userRole = 'member';
          try {
             userRole = getRole(senderQQ);
          } catch(e) {}

          if (userRole !== 'master' && userRole !== 'owner' && senderQQ !== sharedState.ownerQQ) {
              if (isGroup && !isGroupAllowed(chatId)) return;
              if (!isQQAllowed(senderQQ)) return;
          }

          // ==========================================
          // 🌟 绝对门禁：全局与局部映射替换
          // ==========================================
          if (isGroup) {
              let pureText = stdMsg.pureText || "";
              let currentPrefix = '';
              
              for (const p of cmdConfig.prefixes) {
                  if (pureText.startsWith(p)) { currentPrefix = p; break; }
              }
              
              // 剥离前缀，获取纯净文本
              let textWithoutPrefix = currentPrefix ? pureText.slice(currentPrefix.length).trim() : pureText;
              
              if (textWithoutPrefix) {
                  const parts = textWithoutPrefix.split(/\s+/);
                  const baseCmd = parts[0];
                  
                  let originalCmd = null;
                  
                  // 🌟 核心：优先查本群局部映射，再查全局！
                  if (globalThis._commandAliases) {
                      const aliasKeyLocal = `${chatId}_${baseCmd}`;
                      const aliasKeyGlobal = `global_${baseCmd}`;
                      
                      if (globalThis._commandAliases.has(aliasKeyLocal)) {
                          originalCmd = globalThis._commandAliases.get(aliasKeyLocal);
                      } else if (globalThis._commandAliases.has(aliasKeyGlobal)) {
                          originalCmd = globalThis._commandAliases.get(aliasKeyGlobal);
                      }
                  }

                  // 只要查到了映射，直接执行替换
                  if (originalCmd) {
                      parts[0] = originalCmd;
                      const finalText = parts.join(' ');

                      stdMsg.pureText = finalText; 
                      parsed.raw_message = finalText;
                      
                      // 免死金牌
                      stdMsg._isMapped = true;
                      
                      globalThis.print(`[映射触发] 群聊( ${chatId} ) 将 [${baseCmd}] 映射为 [${originalCmd}]，最终纯净指令: ${finalText}`);
                  }
              }
          }
          // 🌟 映射替换结束

          if (parsed.message_id) {
            const msgId = `${stdMsg.selfId}_${parsed.message_id}_${stdMsg.senderId}`;
            if (processedMessages.includes(msgId)) return;
            processedMessages.push(msgId);
            if (processedMessages.length > MAX_CACHE_SIZE) processedMessages.shift();
          }

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
            _ws: ws,
            _isMapped: stdMsg._isMapped // 传递给 runPlugin 强行放行
          };

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

async function main() {
  await lib(); 
  console.log('🚀 XingYuanBot 启动中...\n');

  killPort(4000); 
  killPort(3001); 

  await loadCommandAliases();

  loadCmdConfig();
  watchConfig();

  setInterval(() => {
      const now = Date.now();
      for (const [qq, sess] of interactiveSessions) {
          if (sess.expireAt <= now) interactiveSessions.delete(qq);
      }
  }, 60000);

  const netConfigs = loadNetworkConfig(dataDir);
  const registry = new AdapterRegistry();
  await registry.scan(join(__dirname, 'adapter', 'adapters'));

  const { plugins, errors } = await loadPlugins(registry);
  globalThis.print(`\n✅ 已成功加载 ${plugins.length} 个插件\n`);
  if (errors && errors.length > 0) {
      globalThis.print(`⚠️ 插件加载时产生 ${errors.length} 个错误，请检查。`);
  }

  globalThis.handleIncomingMessage = handleIncomingMessage;
  globalThis._registry = registry;
  globalThis._plugins = plugins;

  globalThis._xyReloadPlugins = async (pluginName) => {
      try {
          if (pluginName && typeof hotReloadPlugin === 'function') {
              await hotReloadPlugin(pluginName, registry);
              return [pluginName];
          } else {
              if (typeof clearPluginCache === 'function') clearPluginCache();
              const result = await loadPlugins(registry);
              globalThis._plugins = result.plugins;
              return result.plugins;
          }
      } catch (e) {
          globalThis.print(`[重载失败] ${e.message}`);
          return [];
      }
  };

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

  startWebPanel({
      registry,
      plugins,
      handleIncomingMessage,
      sharedState,
      __dirname
  });

  globalThis.print('\n✅ 主控与网页面板均启动完成。\n');
  startBot();
}

main().catch(e => {
  globalThis.print(`💥 启动失败: ${e.message}`);
  process.exit(1);
});

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