// xy-lib/ws_server.js
// ✅ WebSocket 服务器端 — 方法路由分发

const WebSocket = require('ws');

// ========================
// 内部状态
// ========================
const handlers = new Map();
const clients = new Set();
let serverInstance = null;

// ========================
// 方法注册
// ========================
globalThis.wsRegister = function (methodName, handler) {
  if (!methodName || typeof handler !== 'function') {
    print(`❌ [wsServer] 注册失败: method=${methodName}, handler必须是函数`);
    return false;
  }
  handlers.set(methodName, handler);
  print(`✅ [wsServer] 已注册方法: ${methodName}`);
  return true;
};

globalThis.wsUnregister = function (methodName) {
  return handlers.delete(methodName);
};

// ========================
// 启动服务器
// ========================
globalThis.wsStartServer = function (options = {}) {
  if (serverInstance) {
    print(`⚠️ [wsServer] 服务器已在运行 (端口 ${options.port || 8765})`);
    return serverInstance;
  }

  const port = options.port || 8765;
  const host = options.host || '0.0.0.0';

  serverInstance = new WebSocket.Server({ port, host });

  serverInstance.on('listening', () => {
    const displayHost = host === '0.0.0.0' ? '0.0.0.0' : host;
    print(`🚀 [wsServer] 监听中 ws://${displayHost}:${port}`);
    writeLog('ws_server', `服务器启动 ws://${displayHost}:${port}`);
  });

  serverInstance.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    clients.add(ws);
    print(`📡 [wsServer] 客户端接入: ${clientIp} (在线 ${clients.size})`);
    writeLog('ws_server', `客户端接入: ${clientIp}`);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        ws.send(JSON.stringify({ success: false, error: '消息必须是合法JSON' }));
        return;
      }

      const method = msg.method;
      const params = msg.data || {};
      const msgId = msg.id || null;

      if (!method) {
        ws.send(JSON.stringify({ id: msgId, success: false, error: '缺少 method 字段' }));
        return;
      }

      const handler = handlers.get(method);
      if (!handler) {
        print(`⚠️ [wsServer] 未注册的方法: ${method}`);
        ws.send(JSON.stringify({ id: msgId, success: false, error: `方法不存在: ${method}` }));
        return;
      }

      // 执行处理方法
      let result;
      try {
        result = await handler(params, ws);
        ws.send(JSON.stringify({ id: msgId, success: true, result }));
        print(`📤 [wsServer] ${method} → 成功`);
      } catch (err) {
        const errMsg = err.message || String(err);
        print(`❌ [wsServer] ${method} 异常: ${errMsg}`);
        ws.send(JSON.stringify({ id: msgId, success: false, error: errMsg }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      print(`🔌 [wsServer] 客户端断开 (在线 ${clients.size})`);
      writeLog('ws_server', `客户端断开, 剩余 ${clients.size}`);
    });

    ws.on('error', (err) => {
      print(`⚠️ [wsServer] 连接错误: ${err.message}`);
    });
  });

  serverInstance.on('error', (err) => {
    print(`❌ [wsServer] 服务器错误: ${err.message}`);
    writeLog('ws_server', `服务器错误: ${err.message}`);
  });

  return serverInstance;
};

// ========================
// 停止服务器
// ========================
globalThis.wsStopServer = function () {
  if (!serverInstance) {
    print(`⚠️ [wsServer] 服务器未运行`);
    return false;
  }
  serverInstance.close(() => {
    serverInstance = null;
    clients.clear();
    print(`🛑 [wsServer] 服务器已停止`);
    writeLog('ws_server', '服务器已停止');
  });
  return true;
};

// ========================
// 广播消息
// ========================
globalThis.wsBroadcast = function (method, data = {}) {
  if (!serverInstance) {
    print(`⚠️ [wsServer] 服务器未运行，无法广播`);
    return 0;
  }
  const payload = JSON.stringify({ method, data, type: 'broadcast' });
  let count = 0;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      count++;
    }
  }
  if (count > 0) {
    print(`📢 [wsServer] 广播 ${method} → ${count} 个客户端`);
  }
  return count;
};

// ========================
// 获取在线客户端数量
// ========================
globalThis.wsGetOnlineCount = function () {
  return clients.size;
};

globalThis.print("✅ [ws_server.js] WebSocket 服务端已挂载 (wsStartServer / wsStopServer / wsRegister / wsBroadcast)");
