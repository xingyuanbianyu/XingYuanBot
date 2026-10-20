// xy-lib/ws_server.js
// ✅ WebSocket 服务器端 — 方法路由分发

const WebSocket = require('ws');

// ========================
// 内部状态
// ========================
const handlers = new Map();
const clients = new Set();
let serverInstance = null;

// 兜底日志工具，防止主程序没挂载 globalThis.print 时崩溃
const log = (msg) => (globalThis.print || console.log)(msg);
const writeLogSafe = (mod, msg) => {
  if (globalThis.writeLog) globalThis.writeLog(mod, msg);
};

// 安全发送函数（防止客户端闪退导致抛错崩溃主进程）
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
globalThis.wsRegister = function (methodName, handler) {
  if (!methodName || typeof handler !== 'function') {
    log(`❌ [wsServer] 注册失败: method=${methodName}, handler必须是函数`);
    return false;
  }
  handlers.set(methodName, handler);
  log(`✅ [wsServer] 已注册方法: ${methodName}`);
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
    log(`⚠️ [wsServer] 服务器已在运行 (端口 ${options.port || 8765})`);
    return serverInstance;
  }

  const port = options.port || 8765;
  const host = options.host || '0.0.0.0';

  serverInstance = new WebSocket.Server({ port, host });

  serverInstance.on('listening', () => {
    const displayHost = host === '0.0.0.0' ? '0.0.0.0' : host;
    log(`🚀 [wsServer] 监听中 ws://${displayHost}:${port}`);
    writeLogSafe('ws_server', `服务器启动 ws://${displayHost}:${port}`);
  });

  serverInstance.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    clients.add(ws);
    log(`📡 [wsServer] 客户端接入: ${clientIp} (在线 ${clients.size})`);
    writeLogSafe('ws_server', `客户端接入: ${clientIp}`);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        safeSend(ws, { success: false, error: '消息必须是合法JSON' });
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
        const result = await handler(params, ws);
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

  serverInstance.on('error', (err) => {
    log(`❌ [wsServer] 服务器错误: ${err.message}`);
    writeLogSafe('ws_server', `服务器错误: ${err.message}`);
  });

  return serverInstance;
};

// ========================
// 停止服务器
// ========================
globalThis.wsStopServer = function () {
  if (!serverInstance) {
    log(`⚠️ [wsServer] 服务器未运行`);
    return false;
  }
  serverInstance.close(() => {
    serverInstance = null;
    clients.clear();
    log(`🛑 [wsServer] 服务器已停止`);
    writeLogSafe('ws_server', '服务器已停止');
  });
  return true;
};

// ========================
// 广播消息
// ========================
globalThis.wsBroadcast = function (method, data = {}) {
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
};

// ========================
// 获取在线客户端数量
// ========================
globalThis.wsGetOnlineCount = function () {
  return clients.size;
};