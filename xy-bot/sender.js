// xy-bot/sender.js
// ✅ 统一消息发送器
// 对外暴露：initSender / bindWs / sendMessage
// 保持 globalThis.bot.send 兼容，旧插件不受影响

let _currentWs = null;

// ========================
// 初始化
// ========================
export function initSender() {
  globalThis._ws = null;
  globalThis.bot = { send: sendMessage };
}

// ========================
// 绑定 WS 连接（收到任何包时刷新）
// ========================
export function bindWs(ws) {
  if (!ws) return;
  _currentWs = ws;
  globalThis._ws = ws;
}

// ========================
// 统一发送入口
// msg: { chatId, isGroup, content?, file? }
// ========================
export function sendMessage(msg) {
  const ws = _currentWs;
  if (!ws || ws.readyState !== 1) {
    print('⚠ [Sender] 无可用连接，消息未发送');
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
  // 文本
  else if (msg.content) {
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
    const kind = msg.file ? '图片' : '文本';
    print(`[发送${kind}] -> ${msg.chatId}`);
    return true;
  } catch (e) {
    print(`⚠ [Sender] 发送失败: ${e.message}`);
    return false;
  }
}