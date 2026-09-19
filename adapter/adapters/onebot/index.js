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
      return null;
    }

    if (raw.post_type !== 'message' && raw.post_type !== 'message_sent') return null;

    // 核心修复：保留原始消息段数组，旧插件（如 #踢）要靠它提取 @ 的 QQ
    const messageSegments = raw.message || [];

    return {
      type: raw.post_type === 'message_sent' ? 'send' : 'receive',
      chatType: raw.message_type === 'group' ? 'group' : 'private',
      chatId: raw.group_id ?? raw.user_id,
      chatName: raw.group_name ?? String(raw.group_id ?? raw.user_id),
      senderId: raw.user_id,
      senderName: raw.sender?.nickname ?? raw.sender?.card ?? String(raw.user_id),
      messageId: raw.message_id ?? raw.id ?? raw.seq ?? raw.msg_id ?? null,

      // 补全旧插件必须的核心字段
      senderQQ: raw.user_id,
      role: raw.sender?.role ?? 'member',
      messageSegments,

      content: messageSegments.map(m => {
        if (m.type === 'reply') {
          const refId = m.data?.id ?? m.data?.message_id ?? '';
          return `[引用ID:${refId}]`;
        }
        if (m.type === 'at') {
          const qq = m.data?.qq ?? m.data?.user_id ?? '';
          return `@{at:${qq}}`;
        }
        return m.data?.text ?? `[${m.type}]`;
      }).join('') ?? '',
    };
  }

  /** 通用 → 平台（标准消息转 OneBot 原始包） */
  fromStandard(reply, std) {
    const target = std.chatType === 'group'
        ? { message_type: 'group', group_id: std.chatId }
        : { message_type: 'private', user_id: std.chatId };

    // 1. 纯文本
    if (typeof reply === 'string') {
      return {
        action: 'send_msg',
        params: { ...target, message: [{ type: 'text', data: { text: reply } }] }
      };
    }

    // 2. 规范图片格式：{ type: 'image', file: Buffer }
    if (reply?.type === 'image' && reply.file) {
      return {
        action: 'send_msg',
        params: {
          ...target,
          message: [{ type: 'image', data: { file: `base64://${reply.file.toString('base64')}` } }]
        }
      };
    }

    // 3. 混合多段：[{ type: 'text', text: '...' }, { type: 'image', file: Buffer }]
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

    // 4. 兼容旧格式：{ file: Buffer } 或 { file: { file: Buffer } }
    if (reply?.file) {
      let buf = null;
      if (Buffer.isBuffer(reply.file)) {
        buf = reply.file;
      } else if (Buffer.isBuffer(reply.file.file)) {
        buf = reply.file.file;
      }

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

    return null; // 不认识的格式，交给框架处理
  }

  /** 订阅事件 */
  onEvent(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
  }

  /** 触发事件 */
  emitEvent(event, payload) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      Promise.resolve(h(payload)).catch(e => console.error(`[事件] ${event}:`, e));
    }
  }

  /** 处理 notice 事件 */
  handleNotice(raw) {
    if (raw.post_type !== 'notice') return;

    if (raw.notice_type === 'group_increase') {
      this.emitEvent('group.increase', {
        groupId: raw.group_id,
        userId: raw.user_id,
        operatorId: raw.operator_id,
        subType: raw.sub_type,
        selfId: raw.self_id,
      });
    } else if (raw.notice_type === 'group_decrease') {
      const ev = raw.sub_type === 'kick' ? 'group.kick' : 'group.decrease';
      this.emitEvent(ev, {
        groupId: raw.group_id,
        userId: raw.user_id,
        operatorId: raw.operator_id,
        selfId: raw.self_id,
      });
    }
  }
}
