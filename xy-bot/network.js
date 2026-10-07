// xy-bot/network.js
import WebSocket, { WebSocketServer } from 'ws';
import fs from 'fs';
import { join } from 'path';
import yaml from 'yaml';

// ==================== 1. 配置加载 ====================
export function loadNetworkConfig(dataDir) {
  const configs = [];
  const serverPath = join(dataDir, 'bot_server.yaml');
  const clientPath = join(dataDir, 'bot_client.yaml');

  if (fs.existsSync(serverPath)) {
    const parsed = yaml.parse(fs.readFileSync(serverPath, 'utf8'));
    const serverCfg = parsed.server || parsed;
    if (serverCfg.port) configs.push({ role: 'server', ...serverCfg });
    else print('⚠ bot_server.yaml 中未找到 port 字段');
  }

  if (fs.existsSync(clientPath)) {
    const parsed = yaml.parse(fs.readFileSync(clientPath, 'utf8'));
    const clientCfg = parsed.client || parsed;
    if (clientCfg.url) configs.push({ role: 'client', ...clientCfg });
    else if (clientCfg.host && clientCfg.port) configs.push({
      role: 'client', ...clientCfg, url: `ws://${clientCfg.host}:${clientCfg.port}`
    });
    else print('⚠ bot_client.yaml 中未找到 url 或 host+port 字段');
  }

  return configs;
}

// ==================== 2. 核心参数 ====================
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 30000;
const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT = 10000;

export function startNetwork(configs, onMessage, onError) {
  let activeMode = null;       // 'server' | 'client' | null
  let serverInstance = null;   // WebSocketServer 实例
  let serverWs = null;         // 已接入的服务端连接
  let clientWs = null;         // 客户端主动连接

  // 心跳定时器
  let serverPingTimer = null, serverPongTimer = null;
  let clientPingTimer = null, clientPongTimer = null;

  const serverConfig = configs.find(c => c.role === 'server');
  const clientConfig = configs.find(c => c.role === 'client');

  // ==================== 3. 安全工具 ====================
  // 安全关闭一个 WebSocket（不抛异常）
  const safeCloseWs = (ws) => {
    if (!ws) return;
    try {
      // CONNECTING 状态调 terminate 更安全
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close();
      else if (ws.readyState === WebSocket.CLOSING) { /* 等它自己走 */ }
    } catch (_) {}
  };

  // 安全关闭一个 WebSocketServer
  const safeCloseServer = () => {
    if (!serverInstance) return;
    try {
      // 强制关闭所有已建立的连接
      for (const client of serverInstance.clients || []) {
        try { client.terminate(); } catch (_) {}
      }
      serverInstance.close();
    } catch (_) {}
    serverInstance = null;
    serverWs = null;
  };

  // 清除所有定时器
  const clearServerHB = () => {
    clearInterval(serverPingTimer);
    clearTimeout(serverPongTimer);
    serverPingTimer = null;
    serverPongTimer = null;
  };
  const clearClientHB = () => {
    clearInterval(clientPingTimer);
    clearTimeout(clientPongTimer);
    clientPingTimer = null;
    clientPongTimer = null;
  };

  // ==================== 4. 竞争切换逻辑 ====================
  const setActive = (mode) => {
    if (activeMode === mode) return;
    print(`\n🔄 [网络切换] 激活模式: ${mode === 'server' ? '服务端监听' : '客户端主动连接'}`);
    activeMode = mode;

    // 变成 Server：主动断开 Client
    if (mode === 'server' && clientWs) {
      print('👉 触发竞争: 服务端被连上，关闭客户端主动连接...');
      clearClientHB();
      safeCloseWs(clientWs);
      clientWs = null;
    }
    // 变成 Client：关闭 Server 监听
    else if (mode === 'client' && serverInstance) {
      print('👉 触发竞争: 客户端连上了，服务端停止监听...');
      safeCloseServer();
    }
  };

  // ==================== 5. 服务端逻辑 ====================
  const startServerHeartbeat = (ws) => {
    clearServerHB();
    serverPingTimer = setInterval(() => {
      if (!serverWs || serverWs.readyState !== WebSocket.OPEN) return;
      try { serverWs.ping(); } catch (_) {}
      serverPongTimer = setTimeout(() => {
        print('⚠ [网络] 服务端未收到 Pong，判定失联！');
        safeCloseWs(serverWs);
      }, HEARTBEAT_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  };

  const tryListen = (port) => {
    if (!port) return;
    safeCloseServer();

    try {
      serverInstance = new WebSocketServer({ port, host: '0.0.0.0' });
    } catch (e) {
      print(`❌ [网络] 服务端启动失败: ${e.message}`);
      return;
    }

    serverInstance.on('listening', () => print(`💡 [网络] 服务端开始监听端口: ${port}`));
    serverInstance.on('error', (e) => print(`❌ [网络] 服务端监听错误: ${e.message}`));

    serverInstance.on('connection', (ws) => {
      print(`✅ [网络] 服务端成功接入 NapCat 连接！`);
      setActive('server');
      serverWs = ws;

      ws.on('message', (data) => {
        try { onMessage(data.toString(), ws); } catch (e) { print(`⚠ [网络] onMessage 异常: ${e.message}`); }
      });
      ws.on('pong', () => clearTimeout(serverPongTimer));
      ws.on('error', (e) => print(`⚠ [网络] 服务端连接错误: ${e.message}`));

      ws.on('close', () => {
        print('⚠ [网络] 服务端连接已断开');
        clearServerHB();
        serverWs = null;
        if (activeMode === 'server') {
          activeMode = null;
          print('👉 触发竞争: 服务端断开，重启监听 + 启动客户端主动连接...');
          tryListen(serverConfig.port);
          startClientReconnect();
        }
      });

      startServerHeartbeat(ws);
    });
  };

  if (serverConfig) tryListen(serverConfig.port);

  // ==================== 6. 客户端逻辑 ====================
  let clientAttempt = 0;
  let clientReconnectTimer = null;

  const startClientHeartbeat = () => {
    clearClientHB();
    clientPingTimer = setInterval(() => {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.ping(); } catch (_) {}
        clientPongTimer = setTimeout(() => {
          print('⚠ [网络] 客户端未收到 Pong，判定失联！');
          safeCloseWs(clientWs);
        }, HEARTBEAT_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);
  };

  const connectClient = () => {
    if (!clientConfig) return;
    if (activeMode === 'server') return; // 已切 Server，不再连
    if (clientWs) return;                // 已有连接

    print(`🔗 [网络] 正在主动连接 NapCat: ${clientConfig.url}...`);

    try {
      clientWs = new WebSocket(clientConfig.url);
    } catch (e) {
      print(`❌ [网络] 客户端创建失败: ${e.message}`);
      clientWs = null;
      return;
    }

    // 🌟 关键修复：error 必须监听，否则 Node 直接崩
    clientWs.on('error', (e) => {
      print(`⚠ [网络] 客户端连接错误: ${e.message}`);
      // 不在这里处理重连，交给 close 事件
    });

    clientWs.on('open', () => {
      print(`✅ [网络] 客户端成功连接到 NapCat！`);
      clientAttempt = 0;
      setActive('client');
      startClientHeartbeat();
    });

    clientWs.on('message', (data) => {
      try { onMessage(data.toString(), clientWs); } catch (e) { print(`⚠ [网络] onMessage 异常: ${e.message}`); }
    });

    clientWs.on('pong', () => clearTimeout(clientPongTimer));

    clientWs.on('close', () => {
      print('⚠ [网络] 客户端连接已断开');
      clearClientHB();
      clientWs = null;
      // 只有处于 client 模式才重连；如果已经被 server 抢占，不重连
      if (activeMode === 'client') {
        activeMode = null;
      }
      if (activeMode !== 'server') {
        startClientReconnect();
      }
    });
  };

  const startClientReconnect = () => {
    if (!clientConfig) return;
    if (activeMode === 'server') return;
    if (clientReconnectTimer) return;

    const delay = Math.min(RECONNECT_BASE * 2 ** clientAttempt, RECONNECT_MAX);
    clientAttempt++;
    print(`🔄 [网络] 客户端将在 ${delay}ms 后进行第 ${clientAttempt} 次重连...`);

    clientReconnectTimer = setTimeout(() => {
      clientReconnectTimer = null;
      if (!clientWs && activeMode !== 'server') connectClient();
    }, delay);
  };

  if (clientConfig) connectClient();

  // ==================== 7. 返回值（保持原接口） ====================
  return [
    serverConfig ? { role: 'server', ws: () => serverWs, server: () => serverInstance } : null,
    clientConfig ? { role: 'client', ws: () => clientWs, server: () => serverInstance } : null,
  ].filter(Boolean);
}