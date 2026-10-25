import WebSocket, { WebSocketServer } from 'ws';
import fs from 'fs';
import { join } from 'path';
import yaml from 'yaml';

// 🌟 兜底打印
const log = (msg) => (globalThis.print || console.log)(msg);

// ==================== 新增：API 调用管理器 ====================
const pendingRequests = new Map();
const genEcho = () => `api_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

/**
 * 🌟 全局 WS 调用 API 方法
 * 插件里直接调用：await globalThis.wsCall('get_group_list', {})
 * 支持传第4个参数指定 ws 对象：await globalThis.wsCall('action', {}, 15000, msg._ws)
 */
globalThis.wsCall = (action, params = {}, timeoutMs = 15000, targetWs = null) => {
  return new Promise((resolve, reject) => {
    const ws = targetWs || globalThis.activeWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket 未连接，无法调用 API'));
    }

    const echo = genEcho();
    
    // 设置超时
    const timer = setTimeout(() => {
      pendingRequests.delete(echo);
      reject(new Error(`API [${action}] 调用超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    // 存入 Map 等待响应，同时记录所属的 ws，方便断线清理
    pendingRequests.set(echo, {
      ws,
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      }
    });

    // 发送指令
    try {
      ws.send(JSON.stringify({ action, params, echo }));
    } catch (e) {
      clearTimeout(timer);
      pendingRequests.delete(echo);
      reject(e);
    }
  });
};

// 🌟 清理特定 ws 上所有挂起的请求
function cleanupPendingRequests(ws) {
  for (const [echo, req] of pendingRequests.entries()) {
    if (req.ws === ws) {
      req.reject(new Error('WebSocket 连接已断开，API 调用取消'));
      pendingRequests.delete(echo);
    }
  }
}

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

  // 🌟 统一的 WS 消息处理中心
  const processIncoming = (dataStr, ws) => {
    globalThis.activeWs = ws;

    let parsedData = null;
    try { parsedData = JSON.parse(dataStr); } catch (_) {}

    // 拦截：如果是 API 调用响应
    if (parsedData && parsedData.echo && pendingRequests.has(parsedData.echo)) {
      const { resolve } = pendingRequests.get(parsedData.echo);
      pendingRequests.delete(parsedData.echo);
      resolve(parsedData);
      return;
    }

    // 普通事件消息，交还给外部框架处理（加上异常捕获，防止崩溃）
    try {
      onMessage(dataStr, ws);
    } catch (e) {
      log(`❌ [网络] 处理消息时发生未捕获异常: ${e.message}`);
    }
  };

  // ==================== 3. 竞争切换逻辑 ====================
  const setActive = (mode) => {
    if (activeMode === mode) return;
    log(`\n🔄 [网络切换] 激活模式: ${mode === 'server' ? '服务端监听' : '客户端主动连接'}`);
    activeMode = mode;

    if (mode === 'server' && clientWs) {
      log('👉 触发竞争: 服务端被连上，关闭客户端主动连接...');
      clearInterval(clientPingTimer);
      clearTimeout(clientReconnectTimer);
      try { clientWs.close(); } catch (_) {}
      clientWs = null;
    }
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
    
    // 确保旧实例彻底关闭
    if (serverInstance) { 
        try { serverInstance.close(); } catch(_) {} 
        serverInstance = null;
    }
    
    // 稍微延迟，防止端口 TIME_WAIT 导致 EADDRINUSE
    setTimeout(() => {
        try {
            serverInstance = new WebSocketServer({ port, host: '0.0.0.0' });
        } catch (e) {
            log(`❌ [网络] 服务端启动失败: ${e.message}`);
            return;
        }

        serverInstance.on('listening', () => log(`💡 [网络] 服务端开始监听端口: ${port}`));
        serverInstance.on('error', (e) => log(`❌ [网络] 服务端监听错误: ${e.message}`));

        serverInstance.on('connection', (ws) => {
          log(`✅ [网络] 服务端成功接入 NapCat 连接！`);
          setActive('server'); 
          serverWs = ws;
          globalThis.activeWs = ws;

          ws.on('error', (err) => log(`❌ [网络] 服务端连接发生错误: ${err.message}`));
          ws.on('message', (data) => processIncoming(data.toString(), ws));
          ws.on('pong', () => clearTimeout(serverPongTimer)); 

          ws.on('close', () => {
            log('⚠ [网络] 服务端连接已断开');
            clearServerHB();
            
            // 🌟 释放挂起的请求
            cleanupPendingRequests(ws);

            if (serverWs === ws) {
              serverWs = null;
              if (globalThis.activeWs === ws) globalThis.activeWs = null;
            }
            
            if (activeMode === 'server') {
              activeMode = null;
              log('👉 触发竞争: 服务端断开，启动客户端主动连接 & 重新监听...');
              tryListen(serverConfig?.port); 
              startClientReconnect();       
            }
          });

          startServerHeartbeat(ws); 
        });
    }, 500); // 延迟 500ms 启动，避免端口占用
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

    clientWs.on('error', (err) => log(`❌ [网络] 客户端发生错误: ${err.message}`));

    clientWs.on('open', () => {
      log(`✅ [网络] 客户端成功连接到 NapCat！`);
      clientAttempt = 0;
      setActive('client'); 
      globalThis.activeWs = clientWs; 
      startClientHeartbeat();
    });

    clientWs.on('message', (data) => processIncoming(data.toString(), clientWs));
    clientWs.on('pong', () => {}); 

    clientWs.on('close', () => {
      log('⚠ [网络] 客户端连接已断开');
      clearInterval(clientPingTimer);
      
      if (clientWs) {
        // 🌟 释放挂起的请求
        cleanupPendingRequests(clientWs);
        if (globalThis.activeWs === clientWs) globalThis.activeWs = null;
        clientWs = null;
      }
      
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