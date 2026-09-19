// xy-lib/message.mjs

// 挂载全局解构函数：globalThis.parseMsg
globalThis.parseMsg = function(rawMsg) {
  // 1. 兼容处理（防止 rawMsg 为空导致后续报错）
  if (!rawMsg || typeof rawMsg !== 'object') {
    return {
      text: '',
      chatId: '',
      senderName: '未知',
      isGroup: false,
      role: 'member',
      raw: rawMsg
    };
  }

  // 2. 统一解析文本（兼容数组格式和纯文本）
  let text = '';
  if (Array.isArray(rawMsg.message)) {
    text = rawMsg.message
      .filter(seg => seg.type === 'text')
      .map(seg => seg.data?.text?.trim() || '')
      .join(' ');
  } else {
    text = rawMsg.text || rawMsg.message || rawMsg.content || rawMsg.raw_message || '';
  }

  // 3. 解构并返回标准对象
  return {
    text: String(text),
    chatId: String(rawMsg.chatId || rawMsg.group_id || rawMsg.user_id || ''),
    senderName: rawMsg.senderName || rawMsg.sender?.nickname || '未知',
    isGroup: rawMsg.message_type === 'group' || rawMsg.isGroup === true,
    role: rawMsg.role || 'member', // 默认普通成员
    raw: rawMsg // 保留原始数据备用
  };
};

console.log("✅ [xy-lib] 消息解构模块 (message.mjs) 已加载");
