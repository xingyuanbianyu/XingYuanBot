// xy-bot/message-parser.js

const log = (msg) => (globalThis.print || console.log)(msg);

// ========================
// 辅助：CQ码反转义与消息段合并
// ========================
function unescapeCQ(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

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

// ========================
// 提取纯文本和富文本内容
// ========================
function extractText(segments) {
  let content = '';
  let pureText = '';

  for (const seg of segments) {
    if (seg.type === 'text') {
      const text = seg.data?.text || '';
      content += text;
      pureText += text; // 纯文本只提取 text 节点
    } else if (seg.type === 'at') {
      content += `@${seg.data?.qq || ''}`; // 富文本保留 @
    } else if (seg.type === 'image') {
      content += '[图片]'; // 富文本保留占位
    } else if (seg.type === 'face') {
      content += '[表情]';
    }
  }

  return { content: content.trim(), pureText: pureText.trim() };
}

// ========================
// 从原始包解析出标准 msg
// ========================
export function parseIncoming(raw, adapter) {
  if (!raw) return null;

  // 1. 优先走适配器
  if (adapter && typeof adapter.match === 'function' && adapter.match(raw)) {
    try {
      const std = adapter.toStandard(raw);
      
      if (!std) return null; 
      
      return normalizeFromStandard(std, raw);
    } catch (e) {
      log(`[Parser] 适配器解析异常: ${e.message}\n${e.stack}`);
    }
  }

  // 2. 兜底：自己解析（保证旧代码或非标准包也能跑）
  return normalizeFromRaw(raw);
}

// ========================
// 适配器输出 → 统一 msg
// ========================
function normalizeFromStandard(std, raw) {
  // 兼容适配器返回的 content 和 pureText，如果没有 pureText，尝试从 content 里提取或直接用
  const finalPureText = std.pureText !== undefined ? std.pureText : (std.content || '');
  
  return {
    ...std,
    isGroup: std.chatType === 'group',
    text: std.content,
    content: std.content,
    pureText: finalPureText, 
    groupName: std.chatName,          
    senderName: std.senderName,
    rawData: raw,
  };
}

// ========================
// 兜底解析（不依赖适配器）
// ========================
function normalizeFromRaw(raw) {
  const isGroup = raw.message_type === 'group';
  let segments = [];

  // 深度解析 message
  if (typeof raw.message === 'string') {
    // 兜底解析 CQ 码字符串
    if (raw.message.includes('[CQ:')) {
        const cqRegex = /\[CQ:(\w+)((?:,[^\]]+)?)\]/g;
        let lastIndex = 0;
        let match;
        while ((match = cqRegex.exec(raw.message)) !== null) {
            if (match.index > lastIndex) {
                const textStr = raw.message.slice(lastIndex, match.index);
                if (textStr) segments.push({ type: 'text', data: { text: unescapeCQ(textStr) } });
            }
            const type = match[1];
            const dataStr = match[2] || '';
            const data = {};
            if (dataStr) {
              dataStr.slice(1).split(',').forEach(kv => {
                  const eqIdx = kv.indexOf('=');
                  if (eqIdx !== -1) data[kv.slice(0, eqIdx)] = unescapeCQ(kv.slice(eqIdx + 1));
              });
            }
            if (type === 'at') segments.push({ type: 'at', data: { qq: String(data.qq || '') } });
            else if (type === 'image') segments.push({ type: 'image', data: { url: data.url || '', file: data.file || '' } });
            else if (type === 'reply') segments.push({ type: 'reply', data: { id: String(data.id || '') } });
            else segments.push({ type: type, data });
            lastIndex = cqRegex.lastIndex;
        }
        if (lastIndex < raw.message.length) {
            const textStr = raw.message.slice(lastIndex);
            if (textStr) segments.push({ type: 'text', data: { text: unescapeCQ(textStr) } });
        }
    } else {
        segments = [{ type: 'text', data: { text: unescapeCQ(raw.message) } }];
    }
  } else if (Array.isArray(raw.message)) {
    segments = raw.message.map(seg => {
        const type = (seg.type || '').toLowerCase();
        const data = seg.data || {};
        if (type === 'text') return { type, data: { text: unescapeCQ(data.text || '') } };
        if (type === 'at') return { type, data: { qq: String(data.qq || data.user_id || ''), name: data.name || '' } };
        if (type === 'image') return { type, data: { url: data.url || '', file: data.file || '' } };
        if (type === 'reply') return { type, data: { id: String(data.id || '') } };
        return { type, data };
    });
  }

  segments = mergeAdjacentText(segments);
  const { content, pureText } = extractText(segments);

  return {
    type: 'receive',
    chatType: isGroup ? 'group' : 'private',
    chatId: String(raw.group_id ?? raw.user_id ?? ''),
    chatName: raw.group_name ?? String(raw.group_id ?? raw.user_id ?? ''),
    groupName: raw.group_name ?? String(raw.group_id ?? raw.user_id ?? ''),
    senderId: String(raw.user_id ?? ''),
    senderQQ: String(raw.user_id ?? ''),
    senderName: raw.sender?.nickname ?? raw.sender?.card ?? String(raw.user_id ?? ''),
    role: raw.sender?.role ?? 'member',
    messageId: raw.message_id ?? null,
    messageSegments: segments,
    message: segments, // 兼容 dispatcher 里的 msg.message
    content: content,    // 富文本（带@和[图片]）
    pureText: pureText,  // 纯文本（只有文字，用于匹配指令）
    isGroup,
    text: content,
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
  
  // 安全处理 content
  const rawContent = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
  const preview = rawContent.substring(0, 30).replace(/\n/g, ' ');
  
  return `[收] [${tag}] [${chat}] ${sender}: ${preview}`;
}