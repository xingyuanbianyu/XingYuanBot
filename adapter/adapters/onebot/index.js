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

  /** 认不认这个包（给框架路由用） */
  match(raw) {
    return raw.post_type !== undefined;
  }

  /** 平台 → 通用（OneBot 原始包转标准消息） */
  toStandard(raw) {
    // 事件通知 → 走事件链路，不进消息链路
    if (raw.post_type === 'notice') {
      this.handleNotice(raw);
      return null; // 触发完事件后直接返回 null，交给 app.js 丢弃
    }

    if (raw.post_type !== 'message' && raw.post_type !== 'message_sent') return null;

    const messageSegments = raw.message || [];

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
        return `@{at:${qq}}`;
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

  /** 通用 → 平台（标准消息转 OneBot 原始包） */
  fromStandard(reply, std) {
    const target = std.chatType === 'group'
        ? { message_type: 'group', group_id: std.chatId }
        : { message_type: 'private', user_id: std.chatId };

    if (typeof reply === 'string') {
      return {
        action: 'send_msg',
        params: { ...target, message: [{ type: 'text', data: { text: reply } }] }
      };
    }

    if (reply?.type === 'image' && reply.file) {
      return {
        action: 'send_msg',
        params: {
          ...target,
          message: [{ type: 'image', data: { file: `base64://${reply.file.toString('base64')}` } }]
        }
      };
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
        return {
          action: 'send_msg',
          params: {
            ...target,
            message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }]
          }
        };
      }
    }

    return null;
  }

  onEvent(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
  }

  emitEvent(event, payload) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      Promise.resolve(h(payload)).catch(e => console.error(`[事件] ${event}:`, e));
    }
  }

  handleNotice(raw) {
    if (raw.post_type !== 'notice') return;

    const basePayload = {
      groupId: raw.group_id,
      userId: raw.user_id,
      operatorId: raw.operator_id,
      subType: raw.sub_type,
      selfId: String(raw.self_id || ''), 
      raw: raw 
    };

    if (raw.notice_type === 'group_increase') {
      this.emitEvent('group.increase', basePayload);
    } else if (raw.notice_type === 'group_decrease') {
      const ev = raw.sub_type === 'kick' ? 'group.kick' : 'group.decrease';
      this.emitEvent(ev, basePayload);
    } 
    // 🌟 核心：补全撤回事件的发射
    else if (raw.notice_type === 'group_recall') {
      this.emitEvent('group.recall', basePayload);
    } else if (raw.notice_type === 'friend_recall') {
      this.emitEvent('friend.recall', basePayload);
    }
  }
}