// xy-bot/message.js

// 标准化消息结构
export function normalizeMessage(rawData) {
  const postType = rawData.post_type;

  if (postType === 'message' || postType === 'message_sent') {
    const isGroup = rawData.message_type === 'group';
    const segments = parseSegments(rawData.message);
    
    // 拼接纯文本，方便插件做正则匹配（如：提醒我 10分钟后 喝水）
    const content = segments.map(m => {
      if (m.type === 'text') return m.data.text;
      if (m.type === 'at') return `@{at:${m.data.qq}}`;
      if (m.type === 'reply') return `[引用ID:${m.data.id}]`;
      return `[${m.type}]`;
    }).join('');

    return {
      type: 'message',
      id: String(rawData.message_id),
      chatType: isGroup ? 'group' : 'private',
      chatId: String(isGroup ? rawData.group_id : rawData.user_id),
      chatName: rawData.group_name || String(rawData.group_id || rawData.user_id),
      
      // 核心防呆数据（为了兼容之前的插件）
      isGroup: isGroup,
      groupName: rawData.group_name || String(rawData.group_id),
      groupId: rawData.group_id,
      senderId: String(rawData.sender?.user_id || ''),
      senderQQ: String(rawData.sender?.user_id || ''),
      senderName: String(rawData.sender?.nickname || rawData.sender?.card || '未知'),
      
      timestamp: (rawData.time || Date.now() / 1000) * 1000,
      
      // 消息段转换
      segments: segments,
      messageSegments: rawData.message || [], // 旧插件兼容
      content: content, // 拼接后的纯文本
      text: content,    // 兼容旧插件用 text 字段
      
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