// adapter/adapters/onebot/index.js

export default class OneBotAdapter {
  constructor(meta) {
    this.name = meta.name || 'onebot';
    this.platform = meta.platform || 'qq';
    this.eventHandlers = new Map();
  }

  mount(conn) {
    this.ws = conn.ws;
    this.role = conn.role;
  }

  // 判断是不是 OneBot 的包
  match(raw) {
    return raw && raw.post_type !== undefined;
  }

  toStandard(raw) {
    if (raw.post_type === 'notice') {
      return this.normalizeNotice(raw);
    }

    if (raw.post_type === 'request') {
      return this.normalizeRequest(raw);
    }

    if (raw.post_type !== 'message' && raw.post_type !== 'message_sent') return null;

    // 🌟 修复 1：处理 CQ 码字符串
    let messageSegments = raw.message;
    if (typeof messageSegments === 'string') {
      // 极简 CQ 码解析兜底
      messageSegments = this.parseCQCode(messageSegments);
    } else if (!Array.isArray(messageSegments)) {
      messageSegments = [];
    }

    const pureText = messageSegments
      .filter(m => m.type === 'text')
      .map(m => m.data?.text || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const displayContent = messageSegments.map(m => {
      if (m.type === 'reply') {
        const refId = m.data?.id ?? m.data?.message_id ?? '';
        return `[引用ID:${refId}]`;
      }
      if (m.type === 'at') {
        const qq = m.data?.qq ?? m.data?.user_id ?? '';
        return `@{at:${qq}} `;
      }
      if (m.type === 'image') {
        return `[图片]`;
      }
      return m.data?.text ?? `[${m.type}]`;
    }).join(''); 

    const selfId = String(raw.self_id || '');
    const chatId = String(raw.group_id ?? raw.user_id ?? '');
    const senderId = String(raw.user_id ?? '');
    const messageId = raw.message_id ?? raw.id ?? raw.seq ?? raw.msg_id ?? null;

    // 🌟 核心新增：判断这条消息是不是“自己/上号的人”发的
    const isSelf = raw.post_type === 'message_sent' || senderId === selfId;

    return {
      type: raw.post_type === 'message_sent' ? 'send' : 'receive',
      chatType: raw.message_type === 'group' ? 'group' : 'private',
      selfId: selfId,           
      chatId: chatId,
      chatName: raw.group_name ?? String(chatId),
      senderId: senderId,
      senderName: raw.sender?.nickname ?? raw.sender?.card ?? String(senderId),
      messageId: messageId,
      senderQQ: senderId,
      role: raw.sender?.role ?? 'member',
      messageSegments,  
      pureText,         
      content: displayContent, 
      isSelf: isSelf, // 🌟 将标记传出去
    };
  }

  // ==========================================
  // 极简 CQ 码解析器 (当 OneBot 返回 string 时兜底)
  // ==========================================
  parseCQCode(str) {
    const segments = [];
    const regex = /\[CQ:([^,\]]+)(?:,([^\]]+))?\]|([^\[]+)/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
      if (match[3]) {
        segments.push({ type: 'text', data: { text: match[3] } });
      } else {
        const type = match[1];
        const data = {};
        if (match[2]) {
          match[2].split(',').forEach(kv => {
            const [k, v] = kv.split('=');
            if (k) data[k] = v;
          });
        }
        segments.push({ type, data });
      }
    }
    return segments;
  }

  // ==========================================
  // 事件标准化 (Notice & Request)
  // ==========================================
  normalizeNotice(raw) {
    const basePayload = {
      type: 'notice',
      groupId: raw.group_id,
      userId: raw.user_id,
      operatorId: raw.operator_id,
      subType: raw.sub_type,
      selfId: String(raw.self_id || ''), 
      raw: raw 
    };

    if (raw.notice_type === 'group_increase') basePayload.event = 'group.increase';
    else if (raw.notice_type === 'group_decrease') basePayload.event = (raw.sub_type === 'kick' ? 'group.kick' : 'group.decrease');
    else if (raw.notice_type === 'group_recall') basePayload.event = 'group.recall';
    else if (raw.notice_type === 'friend_recall') basePayload.event = 'friend.recall';
    else basePayload.event = raw.notice_type;

    return basePayload;
  }

  normalizeRequest(raw) {
    const basePayload = {
      type: 'request',
      groupId: raw.group_id,
      userId: raw.user_id,
      comment: raw.comment || '',
      flag: raw.flag,
      subType: raw.sub_type, 
      selfId: String(raw.self_id || ''),
      raw: raw 
    };

    if (raw.request_type === 'group') basePayload.event = 'group.request';
    else if (raw.request_type === 'friend') basePayload.event = 'friend.request';
    else basePayload.event = raw.request_type;

    return basePayload;
  }

  // ==========================================
  // 发送消息反向标准化
  // ==========================================
  fromStandard(reply, std) {
    const target = std.chatType === 'group'
        ? { message_type: 'group', group_id: std.chatId }
        : { message_type: 'private', user_id: std.chatId };

    const formatImage = (file) => {
      if (Buffer.isBuffer(file)) {
        return { type: 'image', data: { file: `base64://${file.toString('base64')}` } };
      }
      return { type: 'image', data: { file: String(file) } };
    };

    if (typeof reply === 'string') {
      return { action: 'send_msg', params: { ...target, message: [{ type: 'text', data: { text: reply } }] } };
    }

    if (reply?.type === 'image' && reply.file) {
      return { action: 'send_msg', params: { ...target, message: [formatImage(reply.file)] } };
    }

    if (Array.isArray(reply)) {
      const message = reply.map(s => {
        if (s.type === 'image') {
          const fileObj = s.file || s.data?.file;
          if (fileObj) return formatImage(fileObj);
        }
        if (s.type === 'text') {
          return { type: 'text', data: { text: String(s.text ?? s.data?.text ?? '') } };
        }
        if (s.type === 'at') {
          return { type: 'at', data: { qq: String(s.qq ?? s.data?.qq ?? '') } };
        }
        return s;
      });
      return { action: 'send_msg', params: { ...target, message } };
    }

    if (reply?.file) {
      const buf = Buffer.isBuffer(reply.file) ? reply.file : (Buffer.isBuffer(reply.file.file) ? reply.file.file : null);
      if (buf) {
        return { action: 'send_msg', params: { ...target, message: [formatImage(buf)] } };
      }
    }

    return null;
  }

  // ==========================================
  // 事件订阅与触发
  // ==========================================
  onEvent(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
  }
  
  offEvent(event, handler = null) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    if (handler) handlers.delete(handler);
    else handlers.clear();
  }

  emitEvent(event, payload) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      Promise.resolve(h(payload)).catch(e => console.error(`[事件] ${event}:`, e));
    }
  }
}