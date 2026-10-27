// xy-lib/ws_server.js
// ✅ WebSocket 服务器端 — 方法路由分发 + 心跳保活

const WebSocket = require('ws');

(function () {
  "use strict";
  const VERSION = "1.1.0";
  const NS = "wsServer";

  // 防重复加载
  if (globalThis[NS] && globalThis[NS].version === VERSION) {
    return;
  }

  const handlers = new Map();
  const clients = new Set();
  let serverInstance = null;
  let pingIntervalTimer = null;

  const log = (msg) => (globalThis.print || console.log)(msg);
  const writeLogSafe = (mod, msg) => {
    if (globalThis.writeLog) globalThis.writeLog(mod, msg);
  };

  // 安全发送函数
  function safeSend(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(data));
      } catch (e) {
        log(`⚠️ [wsServer] 发送失败: ${e.message}`);
      }
    }
  }

  // ========================
  // 方法注册
  // ========================
  function wsRegister(methodName, handler) {
    if (!methodName || typeof handler !== 'function') {
      log(`❌ [wsServer] 注册失败: method=${methodName}, handler必须是函数`);
      return false;
    }
    handlers.set(methodName, handler);
    log(`✅ [wsServer] 已注册方法: ${methodName}`);
    return true;
  }

  function wsUnregister(methodName) {
    return handlers.delete(methodName);
  }

  // ========================
  // 启动服务器
  // ========================
  function wsStartServer(options = {}) {
    if (serverInstance) {
      log(`⚠️ [wsServer] 服务器已在运行，请勿重复启动`);
      return serverInstance;
    }

    const port = options.port || 8765;
    const host = options.host || '0.0.0.0';
    // ✅ 允许外部传入鉴权函数，返回 false 则拒绝连接
    const verifyClient = options.verifyClient || (() => true); 

    serverInstance = new WebSocket.Server({ port, host });

    serverInstance.on('listening', () => {
      const displayHost = host === '0.0.0.0' ? '0.0.0.0' : host;
      log(`🚀 [wsServer] 监听中 ws://${displayHost}:${port}`);
      writeLogSafe('ws_server', `服务器启动 ws://${displayHost}:${port}`);
    });

    serverInstance.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress || 'unknown';

      // ✅ 握手鉴权拦截 (如果 verifyClient 返回 false)
      if (!verifyClient(req, ws)) {
        log(`🚫 [wsServer] 拒绝连接: ${clientIp} (鉴权失败)`);
        ws.close(4001, 'Unauthorized');
        return;
      }

      clients.add(ws);
      ws.isAlive = true; // ✅ 标记心跳状态
      
      log(`📡 [wsServer] 客户端接入: ${clientIp} (在线 ${clients.size})`);
      writeLogSafe('ws_server', `客户端接入: ${clientIp}`);

      // 收到 pong 自动标记存活
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString('utf8'));
          // ✅ 防止传 null / 字符串 / 数组 导致崩溃
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            throw new Error('消息必须是 JSON 对象');
          }
        } catch (e) {
          safeSend(ws, { success: false, error: `消息格式错误: ${e.message}` });
          return;
        }

        const method = msg.method;
        const params = msg.data || {};
        const msgId = msg.id || null;

        if (!method) {
          safeSend(ws, { id: msgId, success: false, error: '缺少 method 字段' });
          return;
        }

        const handler = handlers.get(method);
        if (!handler) {
          log(`⚠️ [wsServer] 未注册的方法: ${method}`);
          safeSend(ws, { id: msgId, success: false, error: `方法不存在: ${method}` });
          return;
        }

        // 执行处理方法
        try {
          // ✅ 把 req 也传给 handler，方便业务层获取 IP 或 Headers
          const result = await handler(params, ws, req);
          safeSend(ws, { id: msgId, success: true, result });
          log(`📤 [wsServer] ${method} → 成功`);
        } catch (err) {
          const errMsg = err.message || String(err);
          log(`❌ [wsServer] ${method} 异常: ${errMsg}`);
          safeSend(ws, { id: msgId, success: false, error: errMsg });
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
        log(`🔌 [wsServer] 客户端断开 (在线 ${clients.size})`);
        writeLogSafe('ws_server', `客户端断开, 剩余 ${clients.size}`);
      });

      ws.on('error', (err) => {
        log(`⚠️ [wsServer] 连接错误: ${err.message}`);
      });
    });

    // ✅ 集中处理启动错误（如端口占用）
    serverInstance.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`❌ [wsServer] 启动失败: 端口 ${port} 已被占用！`);
      } else {
        log(`❌ [wsServer] 服务器错误: ${err.message}`);
      }
      writeLogSafe('ws_server', `服务器错误: ${err.message}`);
      serverInstance = null; // 启动失败释放实例
    });

    // ✅ 心跳保活机制（每 30 秒扫一遍，清理僵尸连接）
    const interval = options.pingInterval || 30000;
    pingIntervalTimer = setInterval(() => {
      for (const ws of clients) {
        if (ws.isAlive === false) {
          log(`💀 [wsServer] 清理僵尸连接`);
          clients.delete(ws);
          return ws.terminate(); // 强制断开
        }
        ws.isAlive = false;
        ws.ping(); // 发送 ping，客户端会自动回 pong
      }
    }, interval);

    return serverInstance;
  }

  // ========================
  // 停止服务器
  // ========================
  function wsStopServer() {
    if (!serverInstance) {
      log(`⚠️ [wsServer] 服务器未运行`);
      return false;
    }

    // 清理心跳定时器
    if (pingIntervalTimer) {
      clearInterval(pingIntervalTimer);
      pingIntervalTimer = null;
    }

    // ✅ 优雅关闭：先强制断开所有客户端，再关闭服务
    for (const ws of clients) {
      ws.terminate();
    }
    clients.clear();

    serverInstance.close(() => {
      log(`🛑 [wsServer] 服务器已停止`);
      writeLogSafe('ws_server', '服务器已停止');
    });
    
    serverInstance = null;
    return true;
  }

  // ========================
  // 广播消息
  // ========================
  function wsBroadcast(method, data = {}) {
    if (!serverInstance) {
      log(`⚠️ [wsServer] 服务器未运行，无法广播`);
      return 0;
    }
    const payload = { method, data, type: 'broadcast' };
    let count = 0;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(payload));
          count++;
        } catch (e) {}
      }
    }
    if (count > 0) {
      log(`📢 [wsServer] 广播 ${method} → ${count} 个客户端`);
    }
    return count;
  }

  function wsGetOnlineCount() {
    return clients.size;
  }

  // ========================
  // 挂载全局 & 命名空间
  // ========================
  const api = {
    version: VERSION,
    register: wsRegister,
    unregister: wsUnregister,
    start: wsStartServer,
    stop: wsStopServer,
    broadcast: wsBroadcast,
    getOnlineCount: wsGetOnlineCount,
    getClients: () => Array.from(clients)
  };

  globalThis[NS] = api;

  // 兼容原有的扁平化全局调用
  globalThis.wsRegister = wsRegister;
  globalThis.wsUnregister = wsUnregister;
  globalThis.wsStartServer = wsStartServer;
  globalThis.wsStopServer = wsStopServer;
  globalThis.wsBroadcast = wsBroadcast;
  globalThis.wsGetOnlineCount = wsGetOnlineCount;

  log(`✅ [xy-lib] WS_Server 模块已加载 (v${VERSION})`);
})();