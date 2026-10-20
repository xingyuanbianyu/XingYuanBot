import lib from './xy-bot/lib.cjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import yaml from 'yaml';
import express from 'express';
import fsExtra from 'fs-extra';
import { spawn, execSync } from 'child_process';
import { WebSocket } from 'ws';

import { loadNetworkConfig, startNetwork } from './xy-bot/network.js';
import { AdapterRegistry } from './xy-bot/adapter-registry.js';
import { loadPlugins } from './xy-bot/plugin-loader.js';
import { startBot } from './xy-bot/bot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'xy-data');
const configPath = join(__dirname, 'xy-config', 'config.yaml');
const priorityPath = join(__dirname, 'xy-config', 'priority.yaml'); 

const wsPool = new Map();        
const wsToBotId = new Map();     
const botIdToWs = new Map();     
globalThis._ws = null; 

const processedMessages = new Set();
const MAX_CACHE_SIZE = 2000;
const interactiveSessions = new Map();

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

    globalThis.print(`⚙️ [配置] 前缀/白名单/特权插件 已重载`);
  } catch (e) {}
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

globalThis.bot = {
  send: async (msg) => {
    let targetWs = null;
    if (msg.botId) targetWs = botIdToWs.get(String(msg.botId));
    if (!targetWs && msg._ws) targetWs = msg._ws;
    if (!targetWs) targetWs = globalThis._ws;

    if (!targetWs || targetWs.readyState !== 1) return;

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
          } catch (e) { interactiveSessions.delete(msg.senderQQ); }
          return true; 
      }
  }

  let matchText = (msg.pureText || "").trim();
  let finalPureText = matchText; // 🌟 提取到外层，修复作用域 Bug

  if (!isPriority) {
      let hasValidPrefix = false;

      for (const p of cmdConfig.prefixes) {
        if (matchText.startsWith(p)) {
          hasValidPrefix = true;
          finalPureText = matchText.slice(p.length).trim(); // 剥离前缀
          break;
        }
      }

      const isAdminCmd = /^(启用前缀|禁用前缀|查询前缀|添加前缀|删除前缀|启用指令白名单|禁用指令白名单|查询指令白名单|添加指令白名单|删除指令白名单)/.test(finalPureText);
      let isWhitelisted = false;

      if (!hasValidPrefix && !isAdminCmd && whitelistConfig.enable && whitelistConfig.list.length > 0) {
        for (const word of whitelistConfig.list) {
          if (finalPureText === word || (finalPureText.endsWith(word) && finalPureText.replace(word, '').trim().startsWith('@'))) {
            isWhitelisted = true;
            finalPureText = word; 
            break;
          }
        }
      }

      // 空文本如纯图片不拦截，只有文字且无前缀才拦截
      if (cmdConfig.enable && !hasValidPrefix && !isAdminCmd && !isWhitelisted && matchText) return false;

      if (matchFn) {
        try {
          if (!matchFn(finalPureText)) return false; // 用剥离后的去匹配
        } catch (e) { return false; }
      }
  }

  // 🌟 把 msg 和 rawData 完美融合，既照顾老插件，又兼容新逻辑
  const pluginMsg = {
    ...msg,               
    ...msg.rawData,       
    content: msg.content,               
    text: msg.message || [],            
    pureText: finalPureText, // 🌟 这里的变量能正常读到了
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
    if (!wsPool.has(ws)) {
      wsPool.set(ws, { connectedAt: Date.now() });
      globalThis._ws = ws; 
    }

    try {
        const parsed = JSON.parse(rawData);
        if (parsed.post_type === 'meta_event' || parsed.echo !== undefined) return;

        if (parsed.self_id) {
            const botId = String(parsed.self_id);
            if (!wsToBotId.has(ws)) {
                wsToBotId.set(ws, botId);
                botIdToWs.set(botId, ws);
                globalThis.print(`🔗 [路由] 动态绑定连接成功，Bot QQ: ${botId}`);
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

        if (parsed.post_type === 'message' && parsed.message_id) {
          const msgId = `${stdMsg.selfId}_${parsed.message_id}_${stdMsg.senderId}`;
          if (processedMessages.has(msgId)) return;
          processedMessages.add(msgId);
          if (processedMessages.size > MAX_CACHE_SIZE) processedMessages.clear();
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
            rawData: parsed,
            botId: stdMsg.selfId ? String(stdMsg.selfId) : null,
            _ws: ws 
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

// ========================
// Web面板启动
// ========================
function startWebPanel(registry, plugins) {
    const app = express();
    const PORT = 4000;
    const PUBLIC_IP = '118.178.186.173'; 
    let currentWsPort = 30100; 
    let currentWebUI = 6100; 
    const instances = new Map();

    const PARENT_DIR = join(__dirname, '..');
    let TEMPLATE_DIR = join(PARENT_DIR, 'napcat-template');
    if (!fsExtra.existsSync(TEMPLATE_DIR)) {
        TEMPLATE_DIR = join(PARENT_DIR, 'Napcat');
    }

    app.use(express.json());

    app.get('/', (req, res) => {
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>云挂机平台</title>
            <style>
                body { font-family: sans-serif; background: #1e1e1e; color: #fff; padding: 20px; }
                .card { background: #333; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
                .btn { padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; }
                #qr-img { max-width: 300px; display: none; margin-top: 15px; border: 5px solid #fff; border-radius: 5px; }
            </style>
        </head>
        <body>
            <h2>🚀 云挂机平台</h2>
            <div class="card">
                <h3>新建实例</h3>
                <button class="btn" onclick="createInstance()">启动并扫码登录</button>
                <p id="status" style="color: #aaa; margin-top: 10px;">点击按钮开始扫码...</p>
                <img id="qr-img" src="" alt="二维码加载中...">
            </div>
            <script>
                let currentInstanceId = null;

                async function createInstance() {
                    document.getElementById('status').innerText = '正在启动协议端，请稍候...';
                    document.getElementById('qr-img').style.display = 'none';

                    const res = await fetch('/api/create', { method: 'POST' });
                    const data = await res.json();
                    
                    if (data.success) {
                        document.getElementById('status').innerText = '请使用手机 QQ 扫码登录：';
                        currentInstanceId = data.instanceId;
                        pollQR();
                        pollStatus();
                    } else {
                        document.getElementById('status').innerText = '启动失败: ' + data.msg;
                    }
                }

                function pollQR() {
                    const timer = setInterval(() => {
                        if (!currentInstanceId) return clearInterval(timer);
                        const img = document.getElementById('qr-img');
                        img.src = '/api/qrcode/' + currentInstanceId + '?t=' + Date.now();
                        img.onload = () => { img.style.display = 'block'; };
                        img.onerror = () => { img.style.display = 'none'; };
                    }, 2000);
                }

                function pollStatus() {
                    const timer = setInterval(async () => {
                        if (!currentInstanceId) return clearInterval(timer);
                        const res = await fetch('/api/status/' + currentInstanceId);
                        const data = await res.json();
                        if (data.online) {
                            clearInterval(timer);
                            document.getElementById('status').innerText = '✅ 扫码成功，机器人已成功连入主控！';
                            document.getElementById('qr-img').style.display = 'none';
                            document.getElementById('qr-img').src = "";
                        }
                    }, 3000);
                }
            </script>
        </body>
        </html>
        `);
    });

    app.post('/api/create', async (req, res) => {
        try {
            const wsPort = currentWsPort++;
            const webuiPort = currentWebUI++;
            const instanceId = `user_${Date.now()}`;
            
            const userDir = join(__dirname, 'instances', instanceId);

            if (!fsExtra.existsSync(TEMPLATE_DIR)) {
                return res.status(500).json({ success: false, msg: `找不到协议端模板: ${TEMPLATE_DIR}` });
            }
            
            fsExtra.copySync(TEMPLATE_DIR, userDir);

            const pidFile = join(userDir, 'napcat.pid');
            if (fsExtra.existsSync(pidFile)) fsExtra.removeSync(pidFile);
            const cacheDir = join(userDir, 'data', 'nt_qq');
            if (fsExtra.existsSync(cacheDir)) fsExtra.emptyDirSync(cacheDir);

            const webuiConfigPath = join(userDir, 'config', 'webui.json');
            if (fsExtra.existsSync(webuiConfigPath)) {
                const webuiConfig = fsExtra.readJsonSync(webuiConfigPath);
                webuiConfig.port = webuiPort;
                webuiConfig.host = '0.0.0.0'; 
                fsExtra.writeJsonSync(webuiConfigPath, webuiConfig);
            }

            const onebotConfigPath = join(userDir, 'config', 'onebot11.json');
            if (fsExtra.existsSync(onebotConfigPath)) {
                 const obConfig = fsExtra.readJsonSync(onebotConfigPath);
                 if (obConfig.network && obConfig.network.websocketServers && obConfig.network.websocketServers.length > 0) {
                     obConfig.network.websocketServers[0].port = wsPort;
                 }
                 fsExtra.writeJsonSync(onebotConfigPath, obConfig);
            }

            globalThis.print(`🚀 [面板] 正在拉起实例 ${instanceId} (WS: ${wsPort}, WebUI: ${webuiPort})`);
            
            const child = spawn('bash', ['./napcat.sh'], {
                cwd: userDir,
                env: { 
                    ...process.env, 
                    HOME: userDir, 
                    XDG_CONFIG_HOME: join(userDir, '.config'),
                    NAPCAT_WEBUI_PORT: webuiPort.toString(),
                    NAPCAT_WS_PORT: wsPort.toString()
                },
                stdio: 'inherit' 
            });

            child.on('exit', (code) => {
                globalThis.print(`⚠️ [面板] 实例 ${instanceId} 退出，退出码: ${code}`);
                instances.delete(instanceId);
            });

            instances.set(instanceId, { wsPort, webuiPort, child, online: false, userDir });
            res.json({ success: true, instanceId });

            setTimeout(() => {
                globalThis.print(`🔗 [面板] 尝试接入实例 WS: ws://127.0.0.1:${wsPort}`);
                const newWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
                
                newWs.on('open', () => {
                    const inst = instances.get(instanceId);
                    if (inst) inst.online = true;
                    globalThis.print(`✅ [面板] 实例 ${instanceId} 动态接入成功`);
                });
                
                newWs.on('message', (msg) => handleIncomingMessage(msg.toString(), newWs, registry, plugins));
                
                newWs.on('error', (err) => globalThis.print(`❌ [面板] 实例连接失败: ${err.message}`));
                
                newWs.on('close', () => {
                    globalThis.print(`🔌 [面板] 实例 ${instanceId} WS 连接断开`);
                    wsPool.delete(newWs);
                    const botId = wsToBotId.get(newWs);
                    if (botId) {
                        botIdToWs.delete(botId);
                        wsToBotId.delete(newWs);
                    }
                });
            }, 15000); 

        } catch (e) {
            res.status(500).json({ success: false, msg: e.message });
        }
    });

    app.get('/api/qrcode/:id', (req, res) => {
        const inst = instances.get(req.params.id);
        if (!inst) return res.status(404).send('Not found');
        
        const qrPath = join(inst.userDir, 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'cache', 'qrcode.png');
        
        if (fsExtra.existsSync(qrPath)) {
            res.sendFile(qrPath);
        } else {
            res.status(404).send('QR Code not found');
        }
    });

    app.get('/api/status/:id', (req, res) => {
        const inst = instances.get(req.params.id);
        res.json({ online: inst ? inst.online : false });
    });

    app.listen(PORT, '0.0.0.0', () => {
        globalThis.print(`🚀 网页挂机面板已启动: http://${PUBLIC_IP}:${PORT}`);
    });
}

async function main() {
  await lib(); 
  console.log('🚀 XingYuanBot (全栈核心版) 启动中...\n');

  loadCmdConfig();
  watchConfig();

  const netConfigs = loadNetworkConfig(dataDir);
  const registry = new AdapterRegistry();
  await registry.scan(join(__dirname, 'adapter', 'adapters'));

  const { plugins, errors } = await loadPlugins(registry);
  globalThis.print(`\n✅ 已成功加载 ${plugins.length} 个插件\n`);

  if (netConfigs.length > 0) {
      const connections = await startNetwork(
        netConfigs,
        (rawData, ws) => handleIncomingMessage(rawData, ws, registry, plugins),
        (err) => globalThis.print(`⚠ [网络错误] ${err.message}`)
      );
      registry.mountNetwork(connections);
  }

  startWebPanel(registry, plugins);

  globalThis.print('\n✅ 主控与网页面板均启动完成，已就绪。\n');
  startBot();
}

main().catch(e => {
  globalThis.print(`💥 启动失败: ${e.message}`);
  process.exit(1);
});