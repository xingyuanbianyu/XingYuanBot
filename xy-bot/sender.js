// xy-bot/sender.js
// ✅ 统一消息发送器 (支持多账号精准路由、图文混排、空消息拦截)

let _currentWs = null;
const log = (msg) => (globalThis.print || console.log)(msg);

// ========================
// 初始化
// ========================
export function initSender() {
  globalThis._ws = null;
  globalThis.bot = { send: sendMessage };
}

// ========================
// 绑定 WS 连接（全局兜底）
// ========================
export function bindWs(ws) {
  if (!ws) return;
  _currentWs = ws;
  globalThis._ws = ws;
}

// ========================
// 统一发送入口
// ========================
export function sendMessage(msg) {
  if (!msg || !msg.chatId) {
    log('⚠ [Sender] 发送失败: 缺少 chatId');
    return false;
  }

  // 1. 路由寻找对应的 WebSocket
  let ws = msg._ws;
  if (!ws && msg.botId && globalThis.sharedState?.botIdToWs) {
    ws = globalThis.sharedState.botIdToWs.get(String(msg.botId));
  }
  if (!ws) {
    ws = _currentWs || globalThis.activeWs || globalThis._ws;
  }

  // 1 对应 WebSocket.OPEN
  if (!ws || ws.readyState !== 1) {
    log('⚠ [Sender] 无可用连接，消息未发送');
    return false;
  }

  // 2. 确定发送目标
  // 🌟 修复 1：兼容底层协议，尝试转成 Number，转不了再用 String 兜底
  const chatIdNum = Number(msg.chatId);
  const finalId = isNaN(chatIdNum) ? String(msg.chatId) : chatIdNum;
  
  const target = msg.isGroup
    ? { message_type: 'group', group_id: finalId }
    : { message_type: 'private', user_id: finalId };

  let messagePayload = null;

  // ============================================================
  // 3. 解析消息内容（极度兼容）
  // ============================================================
  
  // 优先级 A：处理 file (Buffer 图片或 图片路径/URL)
  if (msg.file) {
    if (Buffer.isBuffer(msg.file)) {
      messagePayload = [{ type: 'image', data: { file: `base64://${msg.file.toString('base64')}` } }];
    } else if (typeof msg.file === 'string') {
      messagePayload = [{ type: 'image', data: { file: msg.file } }];
    }
  }
  
  // 优先级 B：处理 content (或 message)
  if (!messagePayload) {
    const rawContent = msg.content !== undefined ? msg.content : msg.message;
    
    if (rawContent !== undefined && rawContent !== null) {
      if (Array.isArray(rawContent)) {
        // 已经是消息段数组（兼容 @、图文混排）
        messagePayload = rawContent;
      } else if (typeof rawContent === 'object' && rawContent.type) {
        // 单个消息段对象
        messagePayload = [rawContent];
      } else {
        // 纯文本（数字、布尔、字符串）
        messagePayload = [{ type: 'text', data: { text: String(rawContent) } }];
      }
    }
  }

  // 如果解析完还是空的，直接返回
  if (!messagePayload || messagePayload.length === 0) {
    log('⚠ [Sender] 发送失败: 没有可发送的内容');
    return false;
  }

  // 🌟 修复 2：防范空文本触发 NapCat 崩溃
  // 如果数组里只有一个空字符串的纯文本，直接拒绝发送
  if (messagePayload.length === 1 && messagePayload[0].type === 'text') {
      const textStr = messagePayload[0].data?.text;
      if (!textStr || String(textStr).trim() === '') {
          // log('⚠ [Sender] 拦截了空消息，避免接口报错');
          return false;
      }
  }

  // ============================================================
  // 4. 组装并发送
  // ============================================================
  const payload = {
    action: 'send_msg',
    params: {
      ...target,
      message: messagePayload
    }
  };

  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    log(`⚠ [Sender] 发送异常: ${e.message}`);
    return false;
  }
}