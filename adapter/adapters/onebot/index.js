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

  match(raw) {
    return raw.post_type !== undefined;
  }

  toStandard(raw) {
    // 🌟 优化 1：不再在这里触发事件，统一交给主框架或 Registry 处理
    // 直接返回标准的事件对象，让上层去决定
    if (raw.post_type === 'notice') {
      return this.normalizeNotice(raw);
    }

    if (raw.post_type === 'request') {
      return this.normalizeRequest(raw);
    }

    if (raw.post_type !== 'message' && raw.post_type !== 'message_sent') return null;

    // 🌟 优化 2：兼容 raw.message 为字符串（CQ码）或数组的情况
    let messageSegments = raw.message;
    if (typeof messageSegments === 'string') {
      // 简易 CQ 码兜底（如果配置了 CQ 码模式）
      messageSegments = [{ type: 'text', data: { text: raw.message } }];
    } else if (!Array.isArray(messageSegments)) {
      messageSegments = [];
    }

    const pureText = messageSegments
      .filter(m => m.type === 'text')
      .map(m => m.data?.text || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 🌟 优化 3：优化 displayContent 的拼接，防止 @ 和文字粘连
    const displayContent = messageSegments.map(m => {
      if (m.type === 'reply') {
        const refId = m.data?.id ?? m.data?.message_id ?? '';
        return `[引用ID:${refId}]`;
      }
      if (m.type === 'at') {
        const qq = m.data?.qq ?? m.data?.user_id ?? '';
        return `@{at:${qq}} `; // 加个空格防止粘连
      }
      if (m.type === 'image') {
        return `[图片]`;
      }
      return m.data?.text ?? `[${m.type}]`;
    }).join('') ?? '';

    const selfId = String(raw.self_id || '');
    const chatId = String(raw.group_id ?? raw.user_id ?? '');
    const senderId = String(raw.user_id ?? '');
    const messageId = raw.message_id ?? raw.id ?? raw.seq ?? raw.msg_id ?? null;

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
    };
  }

  // ==========================================
  // 从 toStandard 中拆分出的事件标准化方法
  // ==========================================
  
  normalizeNotice(raw) {
    const basePayload = {
      type: 'notice', // 加上类型标识，方便主框架识别
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
    else basePayload.event = raw.notice_type; // 兜底

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
    else basePayload.event = raw.request_type; // 兜底

    return basePayload;
  }

  // ==========================================
  // 发送消息 (fromStandard)
  // ==========================================
  fromStandard(reply, std) {
    const target = std.chatType === 'group'
        ? { message_type: 'group', group_id: std.chatId }
        : { message_type: 'private', user_id: std.chatId };

    if (typeof reply === 'string') {
      return { action: 'send_msg', params: { ...target, message: [{ type: 'text', data: { text: reply } }] } };
    }

    if (reply?.type === 'image' && reply.file) {
      return { action: 'send_msg', params: { ...target, message: [{ type: 'image', data: { file: `base64://${reply.file.toString('base64')}` } }] } };
    }

    if (Array.isArray(reply)) {
      return {
        action: 'send_msg',
        params: {
          ...target,
          message: reply.map(s =>
              s.type === 'image'
                  ? { type: 'image', data: { file: `base64://${s.file.toString('base64')}` } }
                  : { type: 'text', data: { text: String(s.text ?? '') } }
          )
        }
      };
    }

    if (reply?.file) {
      let buf = null;
      if (Buffer.isBuffer(reply.file)) buf = reply.file;
      else if (Buffer.isBuffer(reply.file.file)) buf = reply.file.file;

      if (buf) {
        return { action: 'send_msg', params: { ...target, message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }] } };
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