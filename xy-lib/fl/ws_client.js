// xy-lib/ws_client.js
// ✅ WebSocket 客户端（多开实例版）

const WebSocket = require('ws');

(function () {
  "use strict";
  const VERSION = "1.1.0";
  const NS = "createWsClient";

  // 防重复加载，避免热更新导致工厂方法被覆盖
  if (globalThis[NS] && globalThis[NS].version === VERSION) {
    return;
  }

  const log = (msg) => (globalThis.print || console.log)(msg);

  class WsClient {
    constructor() {
      this.clientWs = null;
      this.serverUrl = '';
      this.pendingCalls = new Map(); // 等待响应的请求
      this.eventListeners = new Map(); // 广播事件监听器
      this.reconnectTimer = null;
      this.autoReconnect = false;
      this.isManualClose = false; // ✅ 新增：区分手动关闭和意外断开
      this.reconnectAttempts = 0; // ✅ 新增：重连次数记录，方便做退避
    }

    // ========================
    // 连接服务器
    // ========================
    connect(options = {}) {
      return new Promise((resolve, reject) => {
        // 防止重复连接
        if (this.clientWs && (this.clientWs.readyState === WebSocket.OPEN || this.clientWs.readyState === WebSocket.CONNECTING)) {
          log(`⚠️ [wsClient] 已存在连接或正在连接 ${this.serverUrl}`);
          return resolve(this.clientWs);
        }

        this.serverUrl = options.url;
        if (!this.serverUrl) return reject(new Error('参数错误: 缺少 url'));

        // 如果之前有重连定时器，先清掉
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        this.isManualClose = false; // 重置手动关闭标志
        this.autoReconnect = options.reconnect !== false;
        const reconnectDelay = options.reconnectDelay || 3000;
        const timeout = options.timeout || 10000;

        log(`🔗 [wsClient] 连接中 ${this.serverUrl} ...`);

        this.clientWs = new WebSocket(this.serverUrl, {
          handshakeTimeout: timeout,
        });

        let isConnectSettled = false; // 防止超时和 error 双重触发 reject

        const connectTimer = setTimeout(() => {
          if (this.clientWs && this.clientWs.readyState === WebSocket.CONNECTING) {
            if (!isConnectSettled) {
              isConnectSettled = true;
              this.clientWs.terminate();
              reject(new Error(`连接超时: ${this.serverUrl}`));
            }
          }
        }, timeout);

        this.clientWs.on('open', () => {
          clearTimeout(connectTimer);
          if (isConnectSettled) return;
          isConnectSettled = true;
          
          this.reconnectAttempts = 0; // 连接成功，重置重连次数
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
            const { resolve, reject, timer } = this.pendingCalls.get(msgId);
            clearTimeout(timer);
            this.pendingCalls.delete(msgId);

            const isSuccess = msg.success !== undefined ? msg.success : (msg.retcode === 0 || msg.status === 'ok');
            
            if (isSuccess) {
              resolve(msg.data || msg.result || msg);
            } else {
              reject(new Error(msg.error || msg.wording || '服务端返回失败'));
            }
          } else if (msg.post_type === 'meta_event') {
            return; // 忽略心跳包
          } else {
            // 广播事件（兼容 OneBot 的 post_type 和你自定义的 type）
            const eventName = msg.type === 'broadcast' ? msg.method : msg.post_type;
            if (!eventName) return;

            const payload = msg.type === 'broadcast' ? msg.data : msg;
            
            // 触发特定事件监听
            const listeners = this.eventListeners.get(eventName) || [];
            for (const fn of listeners) {
              try { fn(payload); } catch (e) { log(`❌ [wsClient] 事件回调异常: ${e.message}`); }
            }

            // 触发通配符监听
            const wildcardListeners = this.eventListeners.get('*') || [];
            for (const fn of wildcardListeners) {
              try { fn(msg); } catch (e) { log(`❌ [wsClient] 默认回调异常: ${e.message}`); }
            }
          }
        });

        this.clientWs.on('close', (code, reason) => {
          clearTimeout(connectTimer);
          
          log(`🔌 [wsClient] 连接已关闭 (code: ${code})`);
          if (globalThis.writeLog) globalThis.writeLog('ws_client', `连接关闭 code=${code}`);

          // 清理所有 pending
          for (const [id, { reject, timer }] of this.pendingCalls.entries()) {
            clearTimeout(timer);
            reject(new Error('连接已关闭'));
          }
          this.pendingCalls.clear();

          this.clientWs = null;

          // 🌟 核心修复：如果是手动关闭，或者明确不需要重连，直接返回
          if (this.isManualClose || !this.autoReconnect) return;

          // 自动重连逻辑
          this.reconnectAttempts++;
          log(`🔄 [wsClient] ${reconnectDelay}ms 后尝试第 ${this.reconnectAttempts} 次重连...`);
          
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            // 重连时不能重置 autoReconnect 为 true，否则用户中途断开又会自动连上
            this.connect({ url: this.serverUrl, reconnect: this.autoReconnect, reconnectDelay })
              .catch(() => {}); // 捕获重连失败的错误，防止未捕获异常
          }, reconnectDelay);
        });

        this.clientWs.on('error', (err) => {
          if (this.clientWs && this.clientWs.readyState === WebSocket.CONNECTING) {
            clearTimeout(connectTimer);
            if (!isConnectSettled) {
              isConnectSettled = true;
              reject(err);
            }
          }
        });
      });
    }

    // ========================
    // 断开连接
    // ========================
    disconnect() {
      this.isManualClose = true; // ✅ 标记为手动关闭
      this.autoReconnect = false;
      
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      if (this.clientWs) {
        // 清除所有事件监听，防止 close 触发重连
        this.clientWs.removeAllListeners();
        this.clientWs.close();
        this.clientWs = null;
        
        // 清理挂起的请求
        for (const [id, { reject, timer }] of this.pendingCalls.entries()) {
          clearTimeout(timer);
          reject(new Error('连接已被手动断开'));
        }
        this.pendingCalls.clear();

        log(`🛑 [wsClient] 已手动断开`);
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

        const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const timeout = options.timeout || 10000;

        // 🌟 修复：由调用方决定，默认智能判断，但允许强制指定
        const protocol = options.protocol || (action.includes('_') ? 'onebot' : 'custom');
        const payload = JSON.stringify(
          protocol === 'onebot' 
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
      if (!this.clientWs) return { connected: false, reconnectAttempts: this.reconnectAttempts };
      const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      return {
        connected: this.clientWs.readyState === WebSocket.OPEN,
        state: states[this.clientWs.readyState],
        url: this.serverUrl,
        pendingCalls: this.pendingCalls.size,
        reconnectAttempts: this.reconnectAttempts
      };
    }
  }

  // 暴露工厂方法
  const factory = function () {
    return new WsClient();
  };
  factory.version = VERSION;
  
  globalThis[NS] = factory;

  log(`✅ [xy-lib] WS_Client 模块已加载 (v${VERSION})`);
})();