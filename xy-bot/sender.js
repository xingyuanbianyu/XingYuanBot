// xy-bot/sender.js
// ✅ 统一消息发送器 (支持多账号精准路由)

let _currentWs = null;

// 日志兼容
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
// msg: { chatId, isGroup, content?, file?, botId?, _ws? }
// ========================
export function sendMessage(msg) {
  // 🌟 核心修复：优先使用消息自带的 _ws，其次通过 botId 查表，最后才用全局兜底
  let ws = msg._ws;
  
  if (!ws && msg.botId && globalThis.sharedState?.botIdToWs) {
    ws = globalThis.sharedState.botIdToWs.get(String(msg.botId));
  }
  
  if (!ws) {
    ws = _currentWs || globalThis.activeWs || globalThis._ws;
  }

  if (!ws || ws.readyState !== 1) {
    log('⚠ [Sender] 无可用连接，消息未发送');
    return false;
  }

  const target = msg.isGroup
    ? { message_type: 'group', group_id: msg.chatId }
    : { message_type: 'private', user_id: msg.chatId };

  let params;

  // 图片
  if (msg.file && Buffer.isBuffer(msg.file)) {
    params = {
      ...target,
      message: [{ type: 'image', data: { file: `base64://${msg.file.toString('base64')}` } }],
    };
  }
  // 文本 (兼容有的插件传数字或对象)
  else if (msg.content !== undefined && msg.content !== null) {
    params = {
      ...target,
      message: [{ type: 'text', data: { text: String(msg.content) } }],
    };
  }
  // 都不认识
  else {
    return false;
  }

  try {
    ws.send(JSON.stringify({ action: 'send_msg', params, echo: Date.now() }));
    // 如果日志太吵，可以注释掉这行
    // const kind = msg.file ? '图片' : '文本';
    // log(`[发送${kind}] -> ${msg.chatId}`);
    return true;
  } catch (e) {
    log(`⚠ [Sender] 发送失败: ${e.message}`);
    return false;
  }
}