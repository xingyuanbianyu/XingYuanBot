// xy-lib/ws_client.js
// ✅ WebSocket 客户端 — 方法调用 + 事件监听

const WebSocket = require('ws');

// ========================
// 内部状态
// ========================
let clientWs = null;
let serverUrl = '';
const pendingCalls = new Map(); // 等待响应的请求
const eventListeners = new Map(); // 广播事件监听器
let reconnectTimer = null;
let autoReconnect = false;

// ========================
// 连接服务器
// ========================
globalThis.wsClientConnect = function (options = {}) {
  return new Promise((resolve, reject) => {
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      print(`⚠️ [wsClient] 已连接 ${serverUrl}`);
      return resolve(clientWs);
    }

    serverUrl = options.url;
    autoReconnect = options.reconnect !== false;
    const reconnectDelay = options.reconnectDelay || 3000;
    const timeout = options.timeout || 10000;

    if (!serverUrl) return reject(new Error('参数错误: 缺少 url'));

    print(`🔗 [wsClient] 连接中 ${serverUrl} ...`);

    clientWs = new WebSocket(serverUrl, {
      handshakeTimeout: timeout,
    });

    const connectTimer = setTimeout(() => {
      if (clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.terminate();
        reject(new Error(`连接超时: ${serverUrl}`));
      }
    }, timeout);

    clientWs.on('open', () => {
      clearTimeout(connectTimer);
      print(`✅ [wsClient] 已连接 ${serverUrl}`);
      writeLog('ws_client', `已连接 ${serverUrl}`);
      resolve(clientWs);
    });

    clientWs.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        print(`⚠️ [wsClient] 收到非法JSON: ${raw}`);
        return;
      }

      // 区分是广播还是方法回包
      if (msg.type === 'broadcast') {
        // 广播事件
        const listeners = eventListeners.get(msg.method) || [];
        for (const fn of listeners) {
          try { fn(msg.data); } catch (e) { print(`❌ [wsClient] 事件回调异常: ${e.message}`); }
        }
      } else if (msg.id && pendingCalls.has(msg.id)) {
        // 方法调用的回包
        const { resolve, reject, timer } = pendingCalls.get(msg.id);
        clearTimeout(timer);
        pendingCalls.delete(msg.id);

        if (msg.success) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error || '服务端返回失败'));
        }
      } else {
        // 没有 id 的普通消息，交给默认监听器
        const listeners = eventListeners.get('*') || [];
        for (const fn of listeners) {
          try { fn(msg); } catch (e) { print(`❌ [wsClient] 默认回调异常: ${e.message}`); }
        }
      }
    });

    clientWs.on('close', (code, reason) => {
      print(`🔌 [wsClient] 连接已关闭 (code: ${code})`);
      writeLog('ws_client', `连接关闭 code=${code}`);

      // 清理所有 pending
      for (const [id, { reject, timer }] of pendingCalls.entries()) {
        clearTimeout(timer);
        reject(new Error('连接已关闭'));
      }
      pendingCalls.clear();

      clientWs = null;

      // 自动重连
      if (autoReconnect) {
        print(`🔄 [wsClient] ${reconnectDelay}ms 后尝试重连...`);
        reconnectTimer = setTimeout(() => {
          wsClientConnect({ url: serverUrl, reconnect: true, reconnectDelay }).catch(() => {});
        }, reconnectDelay);
      }
    });

    clientWs.on('error', (err) => {
      // 连接阶段的错误才 reject，已连接后的错误由 close 处理
      if (clientWs.readyState === WebSocket.CONNECTING) {
        clearTimeout(connectTimer);
        reject(err);
      }
    });
  });
};

// ========================
// 断开连接
// ========================
globalThis.wsClientDisconnect = function () {
  autoReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (clientWs) {
    clientWs.close();
    clientWs = null;
    print(`🛑 [wsClient] 已断开`);
    writeLog('ws_client', '主动断开连接');
  }
};

// ========================
// 调用远程方法
// ========================
globalThis.wsClientCall = function (method, data = {}, options = {}) {
  return new Promise((resolve, reject) => {
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('未连接到服务器'));
    }

    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const timeout = options.timeout || 10000;

    const payload = JSON.stringify({ id: msgId, method, data });

    const timer = setTimeout(() => {
      if (pendingCalls.has(msgId)) {
        pendingCalls.delete(msgId);
        reject(new Error(`方法 ${method} 调用超时`));
      }
    }, timeout);

    pendingCalls.set(msgId, { resolve, reject, timer });

    try {
      clientWs.send(payload);
      print(`📤 [wsClient] 调用 ${method} [${msgId}]`);
    } catch (e) {
      clearTimeout(timer);
      pendingCalls.delete(msgId);
      reject(e);
    }
  });
};

// ========================
// 监听广播事件
// ========================
globalThis.wsClientOn = function (eventName, handler) {
  if (typeof handler !== 'function') {
    print(`❌ [wsClient] handler 必须是函数`);
    return false;
  }
  if (!eventListeners.has(eventName)) {
    eventListeners.set(eventName, []);
  }
  eventListeners.get(eventName).push(handler);
  print(`✅ [wsClient] 已监听事件: ${eventName}`);
  return true;
};

globalThis.wsClientOff = function (eventName, handler) {
  if (!eventListeners.has(eventName)) return false;
  const list = eventListeners.get(eventName);
  if (handler) {
    const idx = list.indexOf(handler);
    if (idx > -1) list.splice(idx, 1);
  } else {
    eventListeners.delete(eventName);
  }
  return true;
};

// ========================
// 状态查询
// ========================
globalThis.wsClientStatus = function () {
  if (!clientWs) return { connected: false };
  const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
  return {
    connected: clientWs.readyState === WebSocket.OPEN,
    state: states[clientWs.readyState],
    url: serverUrl,
    pendingCalls: pendingCalls.size,
  };
};

globalThis.print("✅ [ws_client.js] WebSocket 客户端已挂载 (wsClientConnect / wsClientCall / wsClientOn / wsClientDisconnect)");