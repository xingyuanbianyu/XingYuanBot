// xy-bot/message.js

// ========================
// 辅助：CQ码反转义
// ========================
function unescapeCQ(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

// ========================
// 🌟 新增：合并相邻的文本节点
// ========================
function mergeAdjacentText(segments) {
  if (!Array.isArray(segments)) return segments;
  const result = [];
  for (const seg of segments) {
    if (seg.type === 'text' && result.length > 0 && result[result.length - 1].type === 'text') {
      result[result.length - 1].data.text += seg.data.text;
    } else {
      result.push(seg);
    }
  }
  return result;
}

// 标准化消息结构
export function normalizeMessage(rawData) {
  if (!rawData) return null;
  const postType = rawData.post_type;

  // 兼容 message 和 message_sent (自己发出的消息)
  if (postType === 'message' || postType === 'message_sent') {
    const isGroup = rawData.message_type === 'group';
    
    // 🌟 修复 1：精确处理 chatId
    let chatId;
    if (isGroup) {
      chatId = String(rawData.group_id || '');
    } else {
      // 私聊接收：user_id 是对方；私聊发送：target_id 是对方，user_id 可能是自己
      chatId = String(rawData.target_id || rawData.user_id || '');
    }

    // 🌟 修复 2：严格防范 sender 缺失导致 "undefined" 字符串
    const senderUserId = rawData.sender?.user_id;
    const senderId = senderUserId !== undefined ? String(senderUserId) : (isGroup ? String(rawData.user_id || '') : chatId);
    const senderName = String(rawData.sender?.nickname || rawData.sender?.card || '未知');

    // 🌟 修复 3：严格判断时间戳
    let timestamp = Date.now();
    if (rawData.time !== undefined && rawData.time !== null) {
      const parsedTime = Number(rawData.time);
      if (!Number.isNaN(parsedTime)) {
        timestamp = parsedTime * 1000;
      }
    }

    // 🌟 修复 4：解析并合并相邻的纯文本段
    let segments = parseSegments(rawData.message);
    segments = mergeAdjacentText(segments);

    return {
      type: 'message',
      postType: postType,
      id: String(rawData.message_id || ''),
      messageId: String(rawData.message_id || ''), // 🌟 双命名兜底
      chatType: isGroup ? 'group' : 'private',
      chatId: chatId,
      senderId: senderId,
      senderName: senderName,
      timestamp: timestamp,
      segments: segments,
      raw: rawData 
    };
  }

  if (postType === 'notice') {
    return normalizeNotice(rawData);
  }

  if (postType === 'request') {
      return {
          type: 'request',
          subType: rawData.request_type,
          chatId: String(rawData.group_id || rawData.user_id || ''),
          senderId: String(rawData.user_id || ''),
          // 🌟 修复 5：对附言进行反转义，防止特殊符号导致乱码
          comment: unescapeCQ(rawData.comment || ''),
          flag: rawData.flag || '',
          raw: rawData
      };
  }

  return null;
}

// ========================
// 消息段解析
// ========================
function parseSegments(message) {
  if (!message) return [];

  // 1. 处理 Array 格式 (最标准)
  if (Array.isArray(message)) {
    return message.map(seg => {
      const type = (seg.type || '').toLowerCase();
      const data = seg.data || {};
      
      if (type === 'text') return { type: 'text', data: { text: unescapeCQ(data.text || '') } };
      // 🌟 修复 6：at 节点补充 name 字段（如果有的话）
      if (type === 'at') return { type: 'at', data: { qq: String(data.qq || data.user_id || ''), name: data.name || '' } };
      if (type === 'image') return { type: 'image', data: { url: data.url || '', file: data.file || '', summary: data.summary || '' } };
      if (type === 'reply') return { type: 'reply', data: { id: String(data.id || '') } };
      if (type === 'face') return { type: 'face', data: { id: String(data.id || '') } };
      
      return { type: type, data: data };
    });
  }

  // 2. 处理 String 格式 (CQ 码兜底)
  if (typeof message === 'string') {
    if (!message.includes('[CQ:')) {
        return [{ type: 'text', data: { text: unescapeCQ(message) } }];
    }
    
    const segments = [];
    const cqRegex = /\[CQ:(\w+)((?:,[^\]]+)?)\]/g;
    let lastIndex = 0;
    let match;

    while ((match = cqRegex.exec(message)) !== null) {
        if (match.index > lastIndex) {
            const textStr = message.slice(lastIndex, match.index);
            if (textStr) segments.push({ type: 'text', data: { text: unescapeCQ(textStr) } });
        }
        
        const type = match[1];
        const dataStr = match[2] || '';
        const data = {};
        
        if (dataStr) {
          dataStr.slice(1).split(',').forEach(kv => {
              const eqIndex = kv.indexOf('=');
              if (eqIndex !== -1) {
                const k = kv.slice(0, eqIndex);
                const v = kv.slice(eqIndex + 1);
                data[k] = unescapeCQ(v); 
              }
          });
        }

        if (type === 'at') {
            segments.push({ type: 'at', data: { qq: String(data.qq || ''), name: data.name || '' } });
        } else if (type === 'image') {
            segments.push({ type: 'image', data: { url: data.url || '', file: data.file || '', summary: data.summary || '' } });
        } else if (type === 'reply') {
            segments.push({ type: 'reply', data: { id: String(data.id || '') } });
        } else if (type === 'face') {
            segments.push({ type: 'face', data: { id: String(data.id || '') } });
        } else {
            segments.push({ type: type, data });
        }
        
        lastIndex = cqRegex.lastIndex;
    }

    if (lastIndex < message.length) {
        const textStr = message.slice(lastIndex);
        if (textStr) segments.push({ type: 'text', data: { text: unescapeCQ(textStr) } });
    }

    return segments.length > 0 ? segments : [{ type: 'text', data: { text: unescapeCQ(message) } }];
  }

  return [];
}

// ========================
// 通知事件转换
// ========================
function normalizeNotice(raw) {
  const base = {
    type: 'notice',
    subType: raw.notice_type,
    event: raw.notice_type, 
    chatId: String(raw.group_id || raw.user_id || ''),
    // 🌟 修复 7：通知也严格判断时间戳
    timestamp: (raw.time !== undefined && raw.time !== null) ? Number(raw.time) * 1000 : Date.now(), 
    raw: raw
  };

  if (raw.notice_type === 'group_increase') {
    return { ...base, event: 'group_member_join', targetId: String(raw.user_id || ''), operatorId: String(raw.operator_id || '') };
  }
  if (raw.notice_type === 'group_decrease') {
    return { ...base, event: 'group_member_leave', targetId: String(raw.user_id || ''), operatorId: String(raw.operator_id || '') };
  }
  if (raw.notice_type === 'group_recall') {
      return { ...base, event: 'group_recall', targetId: String(raw.user_id || ''), operatorId: String(raw.operator_id || ''), messageId: String(raw.message_id || '') };
  }
  if (raw.notice_type === 'group_card') {
      return { ...base, event: 'group_card_change', targetId: String(raw.user_id || ''), cardNew: raw.card_new, cardOld: raw.card_old };
  }
  if (raw.notice_type === 'notify' && raw.sub_type === 'poke') {
      return { ...base, event: 'poke', targetId: String(raw.target_id || ''), senderId: String(raw.user_id || '') };
  }

  return base;
}