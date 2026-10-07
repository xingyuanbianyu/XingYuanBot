// ======== xy-lib/fl/index.js ========
console.log("✅ [xy-lib] fl 模块已加载");

// 1. 全局随机数（增强非数字容错）
globalThis.random = function (min, max) {
  min = Number(min);
  max = Number(max);
  if (Number.isNaN(min)) min = 0;
  if (Number.isNaN(max)) max = 0;
  if (min > max) [min, max] = [max, min]; // ✅ 先交换
  min = Math.ceil(min);                    // ✅ 再取整
  max = Math.floor(max);
  if (min === max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

// 2. 全局判空
globalThis.isEmpty = function (val) {
  if (val === null || val === undefined) return true;
  if (typeof val === "number") return Number.isNaN(val);
  if (typeof val === "boolean" || typeof val === "function") return false;
  if (typeof val === "string") return val.trim() === "";
  if (Array.isArray(val)) return val.length === 0;
  // ✅ 合并 Buffer / TypedArray 判断
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) return val.length === 0;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(val)) return val.length === 0;
  if (val instanceof Date) return Number.isNaN(val.getTime());
  if (typeof Map !== "undefined" && val instanceof Map) return val.size === 0;
  if (typeof Set !== "undefined" && val instanceof Set) return val.size === 0;

  // DOM 节点过滤（兼容 Node.js 与浏览器）
  if (typeof Node !== "undefined" && val instanceof Node) return false;

  try {
    return Object.keys(val).length === 0;
  } catch {
    return false;
  }
};

// 3. 全局延时函数（支持取消）
globalThis.sleep = function (ms) {
  let timer = null; // ✅ 去掉多余占位 timer，直接 null
  const promise = new Promise(resolve => {
    timer = setTimeout(() => {
      timer = null;
      resolve();
    }, ms);
  });
  promise.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  return promise;
};

// 4. 全局当前时间字符串（pad 提取优化）
globalThis.now = function () {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// 5. 快捷打印（修复 this 绑定丢失问题）
globalThis.print = console.log.bind(console);

// ================= 全局消息解析器（从 message.mjs 迁移而来） =================
globalThis.parseMsg = function(rawMsg) {
  // 1. 兼容处理（防止 rawMsg 为空导致后续报错）
  if (!rawMsg || typeof rawMsg !== 'object') {
    return {
      text: '',
      chatId: '',
      senderName: '未知',
      isGroup: false,
      role: 'member',
      raw: rawMsg
    };
  }

  // 2. 统一解析文本（兼容数组格式和纯文本）
  let text = '';
  if (Array.isArray(rawMsg.message)) {
    text = rawMsg.message
      .filter(seg => seg.type === 'text')
      .map(seg => seg.data?.text?.trim() || '')
      .join(' ');
  } else {
    text = rawMsg.text || rawMsg.message || rawMsg.content || rawMsg.raw_message || '';
  }

  // 3. 解构并返回标准对象
  return {
    text: String(text),
    chatId: String(rawMsg.chatId || rawMsg.group_id || rawMsg.user_id || ''),
    senderName: rawMsg.senderName || rawMsg.sender?.nickname || '未知',
    isGroup: rawMsg.message_type === 'group' || rawMsg.isGroup === true,
    role: rawMsg.role || 'member', // 默认普通成员
    raw: rawMsg // 保留原始数据备用
  };
};