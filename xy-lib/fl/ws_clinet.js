// xy-lib/ws_client.js
// ✅ WebSocket 客户端（多开实例版）

const WebSocket = require('ws');

// 兜底全局打印，防止报错
const log = (msg) => (globalThis.print || console.log)(msg);

class WsClient {
  constructor() {
    this.clientWs = null;
    this.serverUrl = '';
    this.pendingCalls = new Map(); // 等待响应的请求
    this.eventListeners = new Map(); // 广播事件监听器
    this.reconnectTimer = null;
    this.autoReconnect = false;
  }

  // ========================
  // 连接服务器
  // ========================
  connect(options = {}) {
    return new Promise((resolve, reject) => {
      if (this.clientWs && this.clientWs.readyState === WebSocket.OPEN) {
        log(`⚠️ [wsClient] 已连接 ${this.serverUrl}`);
        return resolve(this.clientWs);
      }

      this.serverUrl = options.url;
      this.autoReconnect = options.reconnect !== false;
      const reconnectDelay = options.reconnectDelay || 3000;
      const timeout = options.timeout || 10000;

      if (!this.serverUrl) return reject(new Error('参数错误: 缺少 url'));

      log(`🔗 [wsClient] 连接中 ${this.serverUrl} ...`);

      this.clientWs = new WebSocket(this.serverUrl, {
        handshakeTimeout: timeout,
      });

      const connectTimer = setTimeout(() => {
        if (this.clientWs && this.clientWs.readyState === WebSocket.CONNECTING) {
          this.clientWs.terminate();
          reject(new Error(`连接超时: ${this.serverUrl}`));
        }
      }, timeout);

      this.clientWs.on('open', () => {
        clearTimeout(connectTimer);
        log(`✅ [wsClient] 已连接 ${this.serverUrl}`);
        if (globalThis.writeLog) globalThis.writeLog('ws_client', `已连接 ${this.serverUrl}`);
        resolve(this.clientWs);
      });

      this.clientWs.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch (e) {
          log(`⚠️ [wsClient] 收到非法JSON: ${raw}`);
          return;
        }

        // 兼容 OneBot 标准协议 (echo) 和你的自定义协议 (id)
        const msgId = msg.echo || msg.id;

        if (msgId && this.pendingCalls.has(msgId)) {
          // 方法调用的回包
          const { resolve, reject, timer } = this.pendingCalls.get(msgId);
          clearTimeout(timer);
          this.pendingCalls.delete(msgId);

          // OneBot 成功一般是 retcode === 0 或者 status === 'ok'
          const isSuccess = msg.success !== undefined ? msg.success : (msg.retcode === 0 || msg.status === 'ok');
          
          if (isSuccess) {
            resolve(msg.data || msg.result || msg); // 返回整个包给调用方自己取
          } else {
            reject(new Error(msg.error || msg.wording || '服务端返回失败'));
          }
        } else if (msg.post_type === 'meta_event') {
          // 忽略心跳包
          return;
        } else {
          // 广播事件（兼容 OneBot 的 post_type 和你自定义的 type）
          const eventName = msg.type === 'broadcast' ? msg.method : msg.post_type;
          if (!eventName) return;

          const listeners = this.eventListeners.get(eventName) || [];
          for (const fn of listeners) {
            try { fn(msg.type === 'broadcast' ? msg.data : msg); } catch (e) { log(`❌ [wsClient] 事件回调异常: ${e.message}`); }
          }

          // 触发通配符监听
          const wildcardListeners = this.eventListeners.get('*') || [];
          for (const fn of wildcardListeners) {
            try { fn(msg); } catch (e) { log(`❌ [wsClient] 默认回调异常: ${e.message}`); }
          }
        }
      });

      this.clientWs.on('close', (code, reason) => {
        log(`🔌 [wsClient] 连接已关闭 (code: ${code})`);
        if (globalThis.writeLog) globalThis.writeLog('ws_client', `连接关闭 code=${code}`);

        // 清理所有 pending
        for (const [id, { reject, timer }] of this.pendingCalls.entries()) {
          clearTimeout(timer);
          reject(new Error('连接已关闭'));
        }
        this.pendingCalls.clear();

        this.clientWs = null;

        // 自动重连
        if (this.autoReconnect) {
          log(`🔄 [wsClient] ${reconnectDelay}ms 后尝试重连...`);
          this.reconnectTimer = setTimeout(() => {
            this.connect({ url: this.serverUrl, reconnect: true, reconnectDelay }).catch(() => {});
          }, reconnectDelay);
        }
      });

      this.clientWs.on('error', (err) => {
        if (this.clientWs && this.clientWs.readyState === WebSocket.CONNECTING) {
          clearTimeout(connectTimer);
          reject(err);
        }
      });
    });
  }

  // ========================
  // 断开连接
  // ========================
  disconnect() {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.clientWs) {
      this.clientWs.close();
      this.clientWs = null;
      log(`🛑 [wsClient] 已断开`);
    }
  }

  // ========================
  // 调用远程方法
  // ========================
  call(action, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.clientWs || this.clientWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('未连接到服务器'));
      }

      // 🌟 兼容 OneBot 的 echo 机制
      const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const timeout = options.timeout || 10000;

      // 根据你对接的是自定义协议还是 OneBot，自动判断组装格式
      const isOneBot = action.includes('_'); // 简单判断是否是 OneBot 格式
      const payload = JSON.stringify(
        isOneBot 
          ? { action, params, echo: msgId }
          : { id: msgId, method: action, data: params }
      );

      const timer = setTimeout(() => {
        if (this.pendingCalls.has(msgId)) {
          this.pendingCalls.delete(msgId);
          reject(new Error(`方法 ${action} 调用超时`));
        }
      }, timeout);

      this.pendingCalls.set(msgId, { resolve, reject, timer });

      try {
        this.clientWs.send(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pendingCalls.delete(msgId);
        reject(e);
      }
    });
  }

  // ========================
  // 监听广播事件
  // ========================
  on(eventName, handler) {
    if (typeof handler !== 'function') return false;
    if (!this.eventListeners.has(eventName)) {
      this.eventListeners.set(eventName, []);
    }
    this.eventListeners.get(eventName).push(handler);
    return true;
  }

  off(eventName, handler) {
    if (!this.eventListeners.has(eventName)) return false;
    const list = this.eventListeners.get(eventName);
    if (handler) {
      const idx = list.indexOf(handler);
      if (idx > -1) list.splice(idx, 1);
    } else {
      this.eventListeners.delete(eventName);
    }
    return true;
  }

  // ========================
  // 状态查询
  // ========================
  status() {
    if (!this.clientWs) return { connected: false };
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return {
      connected: this.clientWs.readyState === WebSocket.OPEN,
      state: states[this.clientWs.readyState],
      url: this.serverUrl,
      pendingCalls: this.pendingCalls.size,
    };
  }
}

// 🌟 核心挂载：暴露一个工厂方法，以后想连多少个号，就 new 多少个！
globalThis.createWsClient = function () {
  return new WsClient();
};