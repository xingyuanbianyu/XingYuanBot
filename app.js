import lib from './xy-bot/lib.cjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import yaml from 'yaml';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
import { loadPlugins, clearPluginCache, hotReloadPlugin, reloadAllPlugins } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';
import { PluginDispatcher } from './xy-bot/dispatcher.js'; 

import { isQQAllowed, isGroupAllowed, reloadConfig } from './xy-bot/config.js';
import { getRole } from './xy-config/config/permissions.js';
import { startWebPanel } from './web-panel.js';

import { initSender, bindWs, sendMessage } from './xy-bot/sender.js';

globalThis.print = globalThis.print || console.log;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');
const configPath = join(__dirname, 'xy-config', 'config.yaml');
const priorityPath = join(__dirname, 'xy-config', 'priority.yaml'); 
const ownerFilePath = join(__dirname, 'xy-data', 'owner.json'); 

const plugins = [];
let reloadLock = false;
let watchTimer = null;

// 端口清理函数
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
            } catch (e) {}
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

globalThis.sharedState = sharedState; 
globalThis._commandAliases = new Map();

// 🌟 全局挂载配置对象
const cmdConfig = { enable: true, prefixes: ['#', '/'] };
const whitelistConfig = { enable: false, list: [] };

globalThis._cmdConfig = cmdConfig;
globalThis._whitelistConfig = whitelistConfig;
globalThis._priorityPlugins = new Set(); 

// 递归寻找 alias.db
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

    if (!aliasDbPath) return;

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

// 🌟 核心新增：将加载函数暴露给全局，供 alias-mapping 插件修改后主动呼叫！
globalThis._loadCommandAliases = loadCommandAliases;

globalThis._groupMembersCache = new Map();
globalThis.getGroupMembers = (groupId) => {
    return globalThis._groupMembersCache.get(String(groupId)) || [];
};

// 🌟 暗雷修复 1：加入防抖锁，防止群友频繁进退群导致 API 被刷爆
const cacheUpdateLocks = new Set();
async function updateGroupMembersCache(groupId, ws = null) {
    if (typeof globalThis.wsCall !== 'function') return;
    const gid = Number(groupId);
    
    if (cacheUpdateLocks.has(gid)) return;
    cacheUpdateLocks.add(gid);

    try {
        const res = await globalThis.wsCall('get_group_member_list', { group_id: gid, no_cache: true }, 15000, ws || globalThis.activeWs);
        if (res && res.status === 'ok' && Array.isArray(res.data)) {
            const cleanList = res.data.map(m => ({
                user_id: m.user_id,
                nickname: m.nickname,
                card: m.card || '',
                role: m.role || 'member'
            }));
            globalThis._groupMembersCache.set(String(gid), cleanList);
            globalThis.print(`🔄 [缓存更新] 群 ${gid} 成员列表已刷新，共 ${cleanList.length} 人。`);
        }
    } catch (e) {
        globalThis.print(`⚠️ [缓存异常] 更新群 ${gid} 成员失败: ${e.message}`);
    } finally {
        setTimeout(() => cacheUpdateLocks.delete(gid), 3000);
    }
}

async function initAllGroupMembersCache(ws = null, retries = 3) {
    if (typeof globalThis.wsCall !== 'function') return;
    try {
        globalThis.print('⏳ [系统] 正在全量拉取所有群成员数据，请稍候...');
        const res = await globalThis.wsCall('get_group_list', {}, 15000, ws || globalThis.activeWs);
        if (res && res.status === 'ok' && Array.isArray(res.data)) {
            const groups = res.data;
            globalThis.print(`🔍 [系统] 发现 ${groups.length} 个群，开始拉取成员信息...`);
            for (const group of groups) {
                await updateGroupMembersCache(group.group_id, ws);
                await new Promise(r => setTimeout(r, 800)); 
            }
            globalThis.print('✅ [系统] 所有群成员数据缓存完毕！');
        } else if (retries > 0) {
            globalThis.print(`⚠️ [系统] 全量缓存失败，${retries} 次重试中...`);
            await new Promise(r => setTimeout(r, 3000));
            await initAllGroupMembersCache(ws, retries - 1);
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

const processedMessages = new Set();
const MAX_CACHE_SIZE = 2000;

const interactiveSessions = new Map();
globalThis._interactiveSessions = interactiveSessions; 

const dispatcher = new PluginDispatcher(() => plugins);

async function handleIncomingMessage(rawData, ws, registry, pluginsArg) {
    if (!ws || ws.readyState !== 1) return;

    bindWs(ws); 

    const activePlugins = pluginsArg || plugins;

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
                    
                    setTimeout(() => initAllGroupMembersCache(ws), 2000); 
                }
            }
        }

        // 进群/退群等事件更新缓存
        if (parsed.post_type === 'notice' && ['group_increase', 'group_decrease', 'group_kick', 'group_card'].includes(parsed.notice_type)) {
            if (parsed.group_id) updateGroupMembersCache(parsed.group_id, ws);
        }

        const stdMsg = registry.parseMessage(parsed);
        if (!stdMsg) return;

        if (parsed.post_type === 'message') {
          const senderQQ = stdMsg.senderId;
          const chatId = stdMsg.chatId;
          const isGroup = stdMsg.chatType === 'group';
          
          let userRole = 'member';
          try {
             userRole = getRole(senderQQ, stdMsg.selfId || parsed.self_id);
          } catch(e) {}

          if (userRole !== 'master' && userRole !== 'owner' && senderQQ !== sharedState.ownerQQ) {
              if (isGroup && !isGroupAllowed(chatId)) return;
              if (!isQQAllowed(senderQQ)) return;
          }

          if (isGroup) {
              let pureText = stdMsg.pureText || "";
              let currentPrefix = '';
              
              for (const p of cmdConfig.prefixes) {
                  if (pureText.startsWith(p)) { currentPrefix = p; break; }
              }
              
              let textWithoutPrefix = currentPrefix ? pureText.slice(currentPrefix.length).trim() : pureText;
              
              if (textWithoutPrefix) {
                  const parts = textWithoutPrefix.split(/\s+/);
                  const baseCmd = parts[0];
                  
                  let originalCmd = null;
                  
                  if (globalThis._commandAliases) {
                      const aliasKeyLocal = `${chatId}_${baseCmd}`;
                      const aliasKeyGlobal = `global_${baseCmd}`;
                      
                      if (globalThis._commandAliases.has(aliasKeyLocal)) {
                          originalCmd = globalThis._commandAliases.get(aliasKeyLocal);
                      } else if (globalThis._commandAliases.has(aliasKeyGlobal)) {
                          originalCmd = globalThis._commandAliases.get(aliasKeyGlobal);
                      }
                  }

                  if (originalCmd) {
                      parts[0] = originalCmd;
                      const finalText = parts.join(' ');

                      stdMsg.pureText = finalText; 
                      parsed.raw_message = finalText;
                      
                      stdMsg._isMapped = true;
                      globalThis.print(`[映射触发] 群聊( ${chatId} ) 将 [${baseCmd}] 映射为 [${originalCmd}]，最终纯净指令: ${finalText}`);
                  }
              }
          }

          if (parsed.message_id) {
            const selfIdSafe = stdMsg.selfId || parsed.self_id || globalThis.botInfo?.qq || '0';
            const msgId = `${selfIdSafe}_${parsed.message_id}_${stdMsg.senderId}`;
            if (processedMessages.has(msgId)) return;
            processedMessages.add(msgId);
            
            if (processedMessages.size > MAX_CACHE_SIZE) {
                const firstItem = processedMessages.values().next().value;
                processedMessages.delete(firstItem);
            }
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
            _isMapped: stdMsg._isMapped
          };

          const context = { 
              priorityPlugins: globalThis._priorityPlugins, 
              cmdConfig: globalThis._cmdConfig, 
              whitelistConfig: globalThis._whitelistConfig, 
              interactiveSessions 
          };
          await dispatcher.dispatch(msg, activePlugins, context);
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
            globalThis._priorityPlugins = new Set(pContent.priority_plugins.map(String));
        } else {
            globalThis._priorityPlugins = new Set();
        }
    } else {
        globalThis._priorityPlugins = new Set();
    }
  } catch (e) {
    globalThis.print(`⚠️ [配置加载失败] ${e.message}`);
  }
}

function watchConfig() {
  const handleWatch = (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(() => { 
              loadCmdConfig(); 
              globalThis.print('🔄 [配置] 指令前缀/优先级配置已热更新');
          }, 200);
      }
  };
  
  try {
    if (fs.existsSync(configPath)) fs.watch(configPath, (et) => handleWatch(et));
    if (fs.existsSync(priorityPath)) fs.watch(priorityPath, (et) => handleWatch(et));
  } catch (e) {}
}

async function main() {
  await lib(); 
  console.log('🚀 XingYuanBot 启动中...\n');

  killPort(4000); 
  killPort(3001); 

  initSender();
  globalThis._configReload = reloadConfig; 

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

  const loaded = await loadPlugins(registry);
  plugins.push(...loaded.plugins);
  globalThis.print(`\n✅ 已成功加载 ${plugins.length} 个插件\n`);
  if (loaded.errors && loaded.errors.length > 0) {
      globalThis.print(`⚠️ 插件加载时产生 ${loaded.errors.length} 个错误，请检查。`);
  }

  globalThis.handleIncomingMessage = handleIncomingMessage;
  globalThis._registry = registry;
  globalThis._plugins = plugins;

  globalThis._xyReloadPlugins = async (pluginName) => {
      if (reloadLock) return [];
      reloadLock = true;
      try {
          if (pluginName && typeof hotReloadPlugin === 'function') {
              await hotReloadPlugin(pluginName, registry);
              return [pluginName];
          }
          if (typeof reloadAllPlugins === 'function') {
              const cache = await reloadAllPlugins(registry);
              plugins.splice(0, plugins.length, ...cache.plugins);
              return plugins;
          }
          if (typeof clearPluginCache === 'function') clearPluginCache();
          const result = await loadPlugins(registry);
          plugins.splice(0, plugins.length, ...result.plugins);
          return plugins;
      } catch (e) {
          globalThis.print(`[重载失败] ${e.message}`);
          return [];
      } finally {
          reloadLock = false;
      }
  };

  globalThis._xyReloadLibs = async (alsoReloadPlugins = false) => {
      if (reloadLock) return { ok: false, reason: 'busy' };
      reloadLock = true;
      try {
          globalThis.print('🔄 [重载] 开始热重载共享库...');
          await lib({ cacheBust: true });
          globalThis.print('✅ [重载] 共享库热重载完成');

          if (alsoReloadPlugins) {
              globalThis.print('🔄 [重载] 顺带全量重载所有插件...');
              const cache = await reloadAllPlugins(registry);
              plugins.splice(0, plugins.length, ...cache.plugins);
          }
          return { ok: true };
      } catch (e) {
          globalThis.print(`❌ [重载] 共享库热重载失败: ${e.message}`);
          return { ok: false, reason: e.message };
      } finally {
          reloadLock = false;
      }
  };

  globalThis._xyReloadAll = () => globalThis._xyReloadLibs(true);

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