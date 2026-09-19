// xy-bot/message.js

// 标准化消息结构
export function normalizeMessage(rawData) {
  const postType = rawData.post_type;

  if (postType === 'message' || postType === 'message_sent') {
    return {
      type: 'message',
      id: String(rawData.message_id),
      chatType: rawData.message_type === 'group' ? 'group' : 'private',
      chatId: String(rawData.message_type === 'group' ? rawData.group_id : rawData.user_id),
      senderId: String(rawData.sender?.user_id || ''),
      senderName: String(rawData.sender?.nickname || rawData.sender?.card || '未知'),
      timestamp: (rawData.time || Date.now() / 1000) * 1000,
      // 消息段转换
      segments: parseSegments(rawData.message),
      // 原始数据保留，方便特殊插件直接读取
      raw: rawData 
    };
  }

  if (postType === 'notice') {
    return normalizeNotice(rawData);
  }

  return null;
}

// 消息段解析
function parseSegments(message) {
  if (typeof message === 'string') {
    return [{ type: 'text', data: { text: message } }];
  }
  if (Array.isArray(message)) {
    return message.map(seg => {
      const type = (seg.type || '').toLowerCase();
      if (type === 'text') return { type: 'text', data: { text: seg.data?.text || '' } };
      if (type === 'at') return { type: 'at', data: { qq: String(seg.data?.qq || seg.data?.user_id) } };
      if (type === 'image') return { type: 'image', data: { url: seg.data?.url || seg.data?.file || '' } };
      if (type === 'reply') return { type: 'reply', data: { id: String(seg.data?.id) } };
      return { type: type, data: seg.data || {} };
    });
  }
  return [];
}

// 通知事件转换
function normalizeNotice(raw) {
  const base = {
    type: 'notice',
    subType: raw.notice_type,
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

  return base;
}
