// xy-bot/message-parser.js
// ✅ 消息解析器
// 职责：OneBot 原始包 → 标准 msg 对象 + 日志行

// ========================
// 从原始包解析出标准 msg
// 优先使用适配器 toStandard，确保 chatId / senderId 准确
// ========================
export function parseIncoming(raw, adapter) {
  // 1. 优先走适配器
  if (adapter && typeof adapter.match === 'function' && adapter.match(raw)) {
    try {
      const std = adapter.toStandard(raw);
      if (std) return normalizeFromStandard(std, raw);
    } catch (e) {
      print(`[Parser] 适配器解析异常: ${e.message}`);
    }
  }

  // 2. 兜底：自己解析（保证旧代码也能跑）
  return normalizeFromRaw(raw);
}

// ========================
// 适配器输出 → 统一 msg
// ========================
function normalizeFromStandard(std, raw) {
  return {
    ...std,
    // 兼容旧字段名
    isGroup: std.chatType === 'group',
    text: std.content,
    groupName: std.chatName,          // 旧插件可能读 groupName
    senderName: std.senderName,
    rawData: raw,
  };
}

// ========================
// 兜底解析（不依赖适配器）
// ========================
function normalizeFromRaw(raw) {
  const isGroup = raw.message_type === 'group';
  const segments = Array.isArray(raw.message) ? raw.message : [];

  return {
    type: 'receive',
    chatType: isGroup ? 'group' : 'private',
    chatId: raw.group_id ?? raw.user_id,
    chatName: raw.group_name ?? String(raw.group_id ?? raw.user_id),
    groupName: raw.group_name ?? String(raw.group_id ?? raw.user_id),
    senderId: raw.user_id,
    senderQQ: raw.user_id,
    senderName: raw.sender?.nickname ?? raw.sender?.card ?? String(raw.user_id),
    role: raw.sender?.role ?? 'member',
    messageId: raw.message_id ?? null,
    messageSegments: segments,
    content: segments.map(seg => seg.data?.text ?? `[${seg.type}]`).join(''),
    isGroup,
    text: segments.map(seg => seg.data?.text ?? `[${seg.type}]`).join(''),
    rawData: raw,
  };
}

// ========================
// 格式化一行日志
// ========================
export function formatLogLine(msg) {
  if (!msg) return '';
  const tag = msg.isGroup ? '群聊' : '私聊';
  const chat = msg.chatName || msg.chatId || '未知';
  const sender = msg.senderName || '';
  const preview = (msg.content || '').substring(0, 30);
  return `[收] [${tag}] [${chat}] ${sender}: ${preview}`;
}