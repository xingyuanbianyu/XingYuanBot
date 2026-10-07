// adapter/adapters/onebot/index.js

// ========================
// 常量定义（避免魔法字符串）
// ========================
const NOTICE_TYPE = {
  GROUP_INCREASE: 'group_increase',
  GROUP_DECREASE: 'group_decrease',
};

const EVENT_NAME = {
  GROUP_INCREASE: 'group.increase',
  GROUP_KICK: 'group.kick',
  GROUP_DECREASE: 'group.decrease',
};

// ========================
// 消息段解析器（可扩展）
// 每个解析器负责：把原始段 → 通用字符串
// ========================
const SEGMENT_PARSERS = {
  text: (seg) => seg.data?.text ?? '',

  reply: (seg) => {
    const refId = seg.data?.id ?? seg.data?.message_id ?? '';
    return `[引用ID:${refId}]`;
  },

  at: (seg) => {
    const qq = seg.data?.qq ?? seg.data?.user_id ?? '';
    return `@{at:${qq}}`;
  },

  image: (seg) => `[image]`,
  face: (seg) => `[face]`,
  record: (seg) => `[record]`,
  video: (seg) => `[video]`,
  forward: (seg) => `[forward]`,
  json: (seg) => `[json]`,
  mface: (seg) => `[mface]`,
};

// ========================
// 出站消息构造器（可扩展）
// 每个构造器负责：把插件返回的格式 → OneBot 消息段数组
// ========================
const OUTBOUND_BUILDERS = [
  // 1. 纯文本
  {
    match: (reply) => typeof reply === 'string',
    build: (reply) => [{ type: 'text', data: { text: reply } }],
  },
  // 2. { type: 'image', file: Buffer }
  {
    match: (reply) => reply?.type === 'image' && Buffer.isBuffer(reply.file),
    build: (reply) => [
      { type: 'image', data: { file: `base64://${reply.file.toString('base64')}` } },
    ],
  },
  // 3. { type: 'video', url: string }
  {
    match: (reply) => reply?.type === 'video' && typeof reply.url === 'string',
    build: (reply) => [{ type: 'video', data: { file: reply.url } }],
  },
  // 4. 混合多段：[{ type: 'text', text }, { type: 'image', file }]
  {
    match: (reply) => Array.isArray(reply),
    build: (reply) =>
      reply.map((seg) => {
        if (seg.type === 'image') {
          if (Buffer.isBuffer(seg.file)) {
            return { type: 'image', data: { file: `base64://${seg.file.toString('base64')}` } };
          }
          return { type: 'image', data: { file: seg.url ?? seg.file ?? '' } };
        }
        if (seg.type === 'video') {
          return { type: 'video', data: { file: seg.url ?? '' } };
        }
        return { type: 'text', data: { text: String(seg.text ?? '') } };
      }),
  },
  // 5. 旧格式 { file: Buffer } 或 { file: { file: Buffer } }
  {
    match: (reply) =>
      reply?.file && (Buffer.isBuffer(reply.file) || Buffer.isBuffer(reply.file?.file)),
    build: (reply) => {
      const buf = Buffer.isBuffer(reply.file) ? reply.file : reply.file.file;
      return [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }];
    },
  },
];

// ========================
// 事件处理器（可扩展）
// 每个处理器负责：把 notice 原始包 → 标准事件对象
// ========================
const NOTICE_HANDLERS = {
  [NOTICE_TYPE.GROUP_INCREASE]: (raw) => ({
    event: EVENT_NAME.GROUP_INCREASE,
    payload: {
      groupId: raw.group_id,
      userId: raw.user_id,
      operatorId: raw.operator_id,
      subType: raw.sub_type,
      selfId: raw.self_id,
    },
  }),

  [NOTICE_TYPE.GROUP_DECREASE]: (raw) => {
    const isKick = raw.sub_type === 'kick';
    return {
      event: isKick ? EVENT_NAME.GROUP_KICK : EVENT_NAME.GROUP_DECREASE,
      payload: {
        groupId: raw.group_id,
        userId: raw.user_id,
        operatorId: raw.operator_id,
        selfId: raw.self_id,
      },
    };
  },
};

// ========================
// 适配器主体
// ========================
export default class OneBotAdapter {
  constructor(meta = {}) {
    this.name = meta.name || 'onebot';
    this.platform = meta.platform || 'qq';
    this.eventHandlers = new Map();
  }

  // --------------------------------------------------
  // 挂载连接
  // --------------------------------------------------
  mount(conn) {
    this.ws = conn.ws;
    this.role = conn.role;
  }

  // --------------------------------------------------
  // 认不认这个包（给框架路由用）
  // --------------------------------------------------
  match(raw) {
    return raw?.post_type !== undefined;
  }

  // ==================================================
  // 平台 → 通用（入站）
  // ==================================================
  toStandard(raw) {
    // 事件通知 → 走事件链路，不进消息链路
    if (raw.post_type === 'notice') {
      this.handleNotice(raw);
      return null;
    }

    // 只处理消息类事件
    if (raw.post_type !== 'message' && raw.post_type !== 'message_sent') {
      return null;
    }

    const messageSegments = Array.isArray(raw.message) ? raw.message : [];

    return {
      type: raw.post_type === 'message_sent' ? 'send' : 'receive',
      chatType: raw.message_type === 'group' ? 'group' : 'private',
      chatId: raw.group_id ?? raw.user_id,
      chatName: raw.group_name ?? String(raw.group_id ?? raw.user_id),
      senderId: raw.user_id,
      senderName:
        raw.sender?.nickname ?? raw.sender?.card ?? String(raw.user_id),
      senderQQ: raw.user_id,
      role: raw.sender?.role ?? 'member',
      messageId: raw.message_id ?? raw.id ?? raw.seq ?? raw.msg_id ?? null,

      // 保留原始消息段（旧插件靠它提取 @ 的 QQ）
      messageSegments,

      // 统一拼接后的可读文本
      content: this.parseSegmentsToString(messageSegments),
    };
  }

  // --------------------------------------------------
  // 消息段数组 → 通用字符串
  // --------------------------------------------------
  parseSegmentsToString(segments) {
    if (!Array.isArray(segments)) return '';
    return segments
      .map((seg) => {
        const parser = SEGMENT_PARSERS[seg.type];
        return parser ? parser(seg) : `[${seg.type}]`;
      })
      .join('');
  }

  // ==================================================
  // 通用 → 平台（出站）
  // ==================================================
  fromStandard(reply, std) {
    if (!reply) return null;

    const target =
      std.chatType === 'group'
        ? { message_type: 'group', group_id: std.chatId }
        : { message_type: 'private', user_id: std.chatId };

    // 依次尝试所有出站构造器
    for (const builder of OUTBOUND_BUILDERS) {
      if (builder.match(reply)) {
        return {
          action: 'send_msg',
          params: { ...target, message: builder.build(reply) },
        };
      }
    }

    // 不认识的格式，交给框架兜底
    return null;
  }

  // ==================================================
  // 事件订阅 / 触发
  // ==================================================
  onEvent(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event).add(handler);
  }

  offEvent(event, handler) {
    const set = this.eventHandlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.eventHandlers.delete(event);
  }

  emitEvent(event, payload) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers || handlers.size === 0) return;
    for (const h of handlers) {
      Promise.resolve()
        .then(() => h(payload))
        .catch((e) => console.error(`[事件] ${event}:`, e));
    }
  }

  // ==================================================
  // 处理 notice 事件（基于注册表分发）
  // ==================================================
  handleNotice(raw) {
    if (raw.post_type !== 'notice') return;

    const handler = NOTICE_HANDLERS[raw.notice_type];
    if (!handler) return; // 未注册的 notice 类型，忽略

    const { event, payload } = handler(raw);
    this.emitEvent(event, payload);
  }
}