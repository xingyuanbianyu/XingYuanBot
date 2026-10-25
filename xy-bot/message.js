// xy-bot/message.js

// 标准化消息结构
export function normalizeMessage(rawData) {
  const postType = rawData.post_type;

  // 兼容 message 和 message_sent (自己发出的消息)
  if (postType === 'message' || postType === 'message_sent') {
    const isGroup = rawData.message_type === 'group';
    
    // 🌟 核心修复：区分“接收的消息”和“自己发送的消息”的 chatId
    // 对于 message_sent 且为私聊时，user_id 是目标（对方），而 sender.user_id 才是自己。
    // 这里 chatId 应该指向“会话目标”。
    let chatId;
    if (isGroup) {
      chatId = String(rawData.group_id);
    } else {
      // 如果是私聊，接收时 user_id 是自己，发送时 user_id 是对方
      // OneBot 11 标准里，私聊的 target_id 或 user_id 通常指向对方
      chatId = String(rawData.target_id || rawData.user_id || '');
    }

    return {
      type: 'message',
      postType: postType, // 保留原始类型，方便插件判断是否是自己发的
      id: String(rawData.message_id),
      chatType: isGroup ? 'group' : 'private',
      chatId: chatId,
      senderId: String(rawData.sender?.user_id || ''),
      senderName: String(rawData.sender?.nickname || rawData.sender?.card || '未知'),
      // 🌟 安全处理时间戳：确保是数字
      timestamp: (Number(rawData.time) || Date.now() / 1000) * 1000,
      // 消息段转换
      segments: parseSegments(rawData.message),
      // 原始数据保留
      raw: rawData 
    };
  }

  if (postType === 'notice') {
    return normalizeNotice(rawData);
  }

  // 如果是 meta_event (心跳等) 或 request (加群/加好友)，可以根据需要扩展
  if (postType === 'request') {
      return {
          type: 'request',
          subType: rawData.request_type, // friend / group
          chatId: String(rawData.group_id || rawData.user_id),
          senderId: String(rawData.user_id),
          comment: rawData.comment || '',
          flag: rawData.flag,
          raw: rawData
      };
  }

  return null;
}

// 消息段解析
function parseSegments(message) {
  if (!message) return [];

  // 1. 处理 Array 格式 (最标准)
  if (Array.isArray(message)) {
    return message.map(seg => {
      const type = (seg.type || '').toLowerCase();
      const data = seg.data || {};
      
      if (type === 'text') return { type: 'text', data: { text: data.text || '' } };
      if (type === 'at') return { type: 'at', data: { qq: String(data.qq || data.user_id || '') } };
      if (type === 'image') {
          // 保留 file 和 url，因为很多插件需要 file 名或 url 下载
          return { type: 'image', data: { url: data.url || '', file: data.file || '' } };
      }
      if (type === 'reply') return { type: 'reply', data: { id: String(data.id || '') } };
      if (type === 'face') return { type: 'face', data: { id: String(data.id || '') } };
      
      return { type: type, data: data };
    });
  }

  // 2. 处理 String 格式 (CQ 码兜底)
  if (typeof message === 'string') {
    // 简单兼容：如果只是纯文本，直接返回
    if (!message.includes('[CQ:')) {
        return [{ type: 'text', data: { text: message } }];
    }
    
    // 简易 CQ 码解析（如果适配器没有处理，这里兜底）
    const segments = [];
    const cqRegex = /\[CQ:(\w+)(?:,([^\]]+))?\]/g;
    let lastIndex = 0;
    let match;

    while ((match = cqRegex.exec(message)) !== null) {
        // 提取 CQ 码前面的纯文本
        if (match.index > lastIndex) {
            segments.push({ type: 'text', data: { text: message.slice(lastIndex, match.index) } });
        }
        
        const type = match[1];
        const dataStr = match[2] || '';
        const data = {};
        dataStr.split(',').forEach(kv => {
            const [k, v] = kv.split('=');
            if (k && v) data[k] = v;
        });

        if (type === 'at') {
            segments.push({ type: 'at', data: { qq: String(data.qq) } });
        } else if (type === 'image') {
            segments.push({ type: 'image', data: { url: data.url || '', file: data.file || '' } });
        } else if (type === 'reply') {
            segments.push({ type: 'reply', data: { id: String(data.id) } });
        } else {
            segments.push({ type: type, data });
        }
        
        lastIndex = cqRegex.lastIndex;
    }

    // 剩下的纯文本
    if (lastIndex < message.length) {
        segments.push({ type: 'text', data: { text: message.slice(lastIndex) } });
    }

    return segments.length > 0 ? segments : [{ type: 'text', data: { text: message } }];
  }

  return [];
}

// 通知事件转换
function normalizeNotice(raw) {
  const base = {
    type: 'notice',
    subType: raw.notice_type,
    event: raw.notice_type, // 🌟 默认把原始 notice_type 作为 event
    chatId: String(raw.group_id || raw.user_id),
    timestamp: Date.now(),
    raw: raw
  };

  if (raw.notice_type === 'group_increase') {
    return { ...base, event: 'group_member_join', targetId: String(raw.user_id) };
  }
  if (raw.notice_type === 'group_decrease') {
    return { ...base, event: 'group_member_leave', targetId: String(raw.user_id) };
  }
  
  // 🌟 增加更多常见通知类型的标准化支持
  if (raw.notice_type === 'group_recall') {
      return { ...base, event: 'group_recall', targetId: String(raw.user_id), operatorId: String(raw.operator_id), messageId: String(raw.message_id) };
  }
  if (raw.notice_type === 'group_card') {
      return { ...base, event: 'group_card_change', targetId: String(raw.user_id), cardNew: raw.card_new, cardOld: raw.card_old };
  }
  if (raw.notice_type === 'notify' && raw.sub_type === 'poke') {
      return { ...base, event: 'poke', targetId: String(raw.target_id), senderId: String(raw.user_id) };
  }

  return base;
}