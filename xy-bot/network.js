import WebSocket, { WebSocketServer } from 'ws';
import fs from 'fs';
import { join } from 'path';
import yaml from 'yaml';

// 🌟 兜底打印
const log = (msg) => (globalThis.print || console.log)(msg);

// ==================== 1. 配置加载 ====================
export function loadNetworkConfig(dataDir) {
  const configs = [];
  const serverPath = join(dataDir, 'bot_server.yaml');
  const clientPath = join(dataDir, 'bot_client.yaml');

  if (fs.existsSync(serverPath)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(serverPath, 'utf8'));
      const serverCfg = parsed.server || parsed;
      if (serverCfg.port) configs.push({ role: 'server', ...serverCfg });
      else log('⚠ bot_server.yaml 中未找到 port 字段');
    } catch (e) { log(`❌ [网络] 解析 bot_server.yaml 失败: ${e.message}`); }
  }

  if (fs.existsSync(clientPath)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(clientPath, 'utf8'));
      const clientCfg = parsed.client || parsed;
      if (clientCfg.url) {
        configs.push({ role: 'client', ...clientCfg });
      } else if (clientCfg.host && clientCfg.port) {
        configs.push({ role: 'client', ...clientCfg, url: `ws://${clientCfg.host}:${clientCfg.port}` });
      } else {
        log('⚠ bot_client.yaml 中未找到 url 或 host+port 字段');
      }
    } catch (e) { log(`❌ [网络] 解析 bot_client.yaml 失败: ${e.message}`); }
  }

  return configs;
}

// ==================== 2. 核心参数 ====================
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 30000;
const HEARTBEAT_INTERVAL = 15000; 
const HEARTBEAT_TIMEOUT = 10000;  

export function startNetwork(configs, onMessage, onError) {
  let activeMode = null;
  let serverInstance = null;
  let serverWs = null;
  let clientWs = null;

  let serverPingTimer = null, serverPongTimer = null;
  let clientPingTimer = null;
  let clientReconnectTimer = null;

  const serverConfig = configs.find(c => c.role === 'server');
  const clientConfig = configs.find(c => c.role === 'client');

  // ==================== 3. 竞争切换逻辑 ====================
  const setActive = (mode) => {
    if (activeMode === mode) return;
    log(`\n🔄 [网络切换] 激活模式: ${mode === 'server' ? '服务端监听' : '客户端主动连接'}`);
    activeMode = mode;

    // 变成 Server：如果 Client 还在连，立刻掐断
    if (mode === 'server' && clientWs) {
      log('👉 触发竞争: 服务端被连上，关闭客户端主动连接...');
      clearInterval(clientPingTimer);
      clearTimeout(clientReconnectTimer);
      try { clientWs.close(); } catch (_) {}
      clientWs = null;
    }
    // 变成 Client：如果 Server 还在监听，立刻停止监听释放端口
    else if (mode === 'client' && serverInstance) {
      log('👉 触发竞争: 客户端连上了，服务端停止监听...');
      try { serverInstance.close(); } catch (_) {}
      serverInstance = null;
    }
  };

  // ==================== 4. 服务端逻辑 ====================
  const clearServerHB = () => {
    clearInterval(serverPingTimer);
    clearTimeout(serverPongTimer);
    serverPingTimer = null;
    serverPongTimer = null;
  };

  const startServerHeartbeat = (ws) => {
    clearServerHB();
    serverPingTimer = setInterval(() => {
      // 🌟 防止旧的 ws 已经被替换或关闭，仍去发 ping
      if (!serverWs || serverWs !== ws || serverWs.readyState !== WebSocket.OPEN) {
        clearServerHB();
        return;
      }
      serverWs.ping();
      serverPongTimer = setTimeout(() => {
        log('⚠ [网络] 服务端未收到 Pong，判定失联！');
        try { serverWs.terminate(); } catch (_) {} 
      }, HEARTBEAT_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  };

  const tryListen = (port) => {
    if (!port) return;
    if (serverInstance) { try { serverInstance.close(); } catch(_) {} }
    serverInstance = new WebSocketServer({ port, host: '0.0.0.0' });

    serverInstance.on('listening', () => log(`💡 [网络] 服务端开始监听端口: ${port}`));
    serverInstance.on('error', (e) => log(`❌ [网络] 服务端监听错误: ${e.message}`));

    serverInstance.on('connection', (ws) => {
      log(`✅ [网络] 服务端成功接入 NapCat 连接！`);
      setActive('server'); 
      serverWs = ws;

      // 🌟 补全服务端错误捕获
      ws.on('error', (err) => {
        log(`❌ [网络] 服务端连接发生错误: ${err.message}`);
      });

      ws.on('message', (data) => onMessage(data.toString(), ws));
      ws.on('pong', () => clearTimeout(serverPongTimer)); 

      ws.on('close', () => {
        log('⚠ [网络] 服务端连接已断开');
        clearServerHB();
        if (serverWs === ws) serverWs = null;
        
        if (activeMode === 'server') {
          activeMode = null;
          log('👉 触发竞争: 服务端断开，启动客户端主动连接 & 重新监听...');
          tryListen(serverConfig?.port); 
          startClientReconnect();       
        }
      });

      startServerHeartbeat(ws); 
    });
  };

  if (serverConfig) tryListen(serverConfig.port);

  // ==================== 5. 客户端逻辑 ====================
  let clientAttempt = 0;

  const startClientHeartbeat = () => {
    clearInterval(clientPingTimer);
    clientPingTimer = setInterval(() => {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.ping();
      }
    }, HEARTBEAT_INTERVAL);
  };

  const connectClient = () => {
    if (activeMode === 'server' || !clientConfig) return;
    log(`🔗 [网络] 正在主动连接 NapCat: ${clientConfig.url}...`);
    
    try {
      clientWs = new WebSocket(clientConfig.url);
    } catch (e) {
      log(`❌ [网络] 客户端连接异常: ${e.message}`);
      return startClientReconnect();
    }

    // 🌟 补全客户端错误捕获
    clientWs.on('error', (err) => {
      log(`❌ [网络] 客户端发生错误: ${err.message}`);
    });

    clientWs.on('open', () => {
      log(`✅ [网络] 客户端成功连接到 NapCat！`);
      clientAttempt = 0;
      setActive('client'); 
      startClientHeartbeat();
    });

    clientWs.on('message', (data) => onMessage(data.toString(), clientWs));
    clientWs.on('pong', () => {}); 

    clientWs.on('close', () => {
      log('⚠ [网络] 客户端连接已断开');
      clearInterval(clientPingTimer);
      if (clientWs) clientWs = null;
      
      if (activeMode === 'client') {
        activeMode = null;
        log('👉 触发竞争: 客户端断开，重新启动服务端监听...');
        if (serverConfig) tryListen(serverConfig.port);
      }
      startClientReconnect();
    });
  };

  const startClientReconnect = () => {
    if (clientConfig && !clientWs && activeMode !== 'server') {
      const delay = Math.min(RECONNECT_BASE * 2 ** clientAttempt, RECONNECT_MAX);
      clientAttempt++;
      log(`🔄 [网络] 客户端将在 ${delay}ms 后进行第 ${clientAttempt} 次重连...`);
      
      clearTimeout(clientReconnectTimer);
      clientReconnectTimer = setTimeout(() => {
        if (!clientWs && activeMode !== 'server') connectClient();
      }, delay);
    }
  };

  if (clientConfig) connectClient();

  return [
    serverInstance ? { role: 'server', ws: () => serverWs } : null,
    clientConfig ? { role: 'client', ws: () => clientWs } : null
  ].filter(Boolean);
}