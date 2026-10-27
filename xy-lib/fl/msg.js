// ======== xy-lib/msg.js ========
// 全局消息工具集：消息段构造 / CQ码解析 / 内容提取
// 设计目标：全局注入，直接 Msg.text('hello') 调用
(function () {
  "use strict";

  const VERSION = "1.0.0";
  const NS = "Msg"; // 命名空间：Msg.text / Msg.at

  // ---------- 幂等：重复加载直接跳过 ----------
  if (globalThis[NS] && globalThis[NS].version === VERSION) {
    console.log(`ℹ️ [xy-lib] Msg ${VERSION} 已加载，跳过`);
    return;
  }

  // ---------- 1. 消息段构造 ----------
  function text(content) {
    return { type: "text", data: { text: String(content) } };
  }

  function at(qq) {
    return { type: "at", data: { qq: String(qq) } };
  }

  function image(file) {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(file)) {
      return { type: "image", data: { file: `base64://${file.toString("base64")}` } };
    }
    return { type: "image", data: { file: String(file) } };
  }

  function reply(messageId) {
    return { type: "reply", data: { id: String(messageId) } };
  }

  // ---------- 2. 内容提取 ----------
  
  // 提取纯文本
  function getPureText(messageSegments) {
    if (!Array.isArray(messageSegments)) return String(messageSegments || "");
    return messageSegments.map(seg => {
      if (seg.type === "text") return seg.data?.text || "";
      return "";
    }).join("");
  }

  // 提取所有 @ 的 QQ (排除 @全体成员)
  function getAtList(messageSegments) {
    const list = [];
    if (!Array.isArray(messageSegments)) return list;
    messageSegments.forEach(seg => {
      if (seg.type === "at" && seg.data?.qq && seg.data.qq !== "all") {
        list.push(String(seg.data.qq));
      }
    });
    return list;
  }

  // 提取引用 ID
  function getReplyId(messageSegments) {
    if (!Array.isArray(messageSegments)) return null;
    const replySeg = messageSegments.find(seg => seg.type === "reply");
    return replySeg ? String(replySeg.data?.id) : null;
  }

  // 提取图片 URL 或 Base64
  function getImageList(messageSegments) {
    const list = [];
    if (!Array.isArray(messageSegments)) return list;
    messageSegments.forEach(seg => {
      if (seg.type === "image" && seg.data) {
        list.push(seg.data.url || seg.data.file);
      }
    });
    return list;
  }

  // ---------- 3. CQ码 转 消息段 ----------
  function parseCQ(cqString) {
    if (!cqString || typeof cqString !== "string") return [];
    const result = [];
    let lastIndex = 0;
    const regex = /\[CQ:(\w+),([^\]]*)\]/g;
    let match;

    while ((match = regex.exec(cqString)) !== null) {
      if (match.index > lastIndex) {
        result.push(text(cqString.slice(lastIndex, match.index)));
      }
      const type = match[1];
      const data = {};
      match[2].split(",").forEach(item => {
        const eqIdx = item.indexOf("=");
        if (eqIdx !== -1) {
          data[item.slice(0, eqIdx)] = item.slice(eqIdx + 1);
        }
      });
      result.push({ type, data });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < cqString.length) {
      result.push(text(cqString.slice(lastIndex)));
    }
    
    return result.length > 0 ? result : [text(cqString)];
  }

  // ---------- 组装并挂载 ----------
  const api = { 
    version: VERSION, 
    text, at, image, reply, 
    getPureText, getAtList, getReplyId, getImageList, 
    parseCQ 
  };

  // 挂载到 globalThis.Msg
  globalThis[NS] = api;

  // 冲突检测（如果你想用更短的短名，比如直接用 text()，可以取消下面这段注释，但不建议，容易污染全局）
  /*
  const conflicts = [];
  for (const k of Object.keys(api)) {
    if (k === "version") continue;
    if (typeof globalThis[k] !== "undefined" && globalThis[k] !== api[k]) {
      conflicts.push(k);
    }
    globalThis[k] = api[k];
  }
  if (conflicts.length) {
    console.warn(`⚠️ [xy-lib] Msg 覆盖了已有全局：${conflicts.join(", ")}`);
  }
  */

  console.log(`✅ [xy-lib] Msg ${VERSION} 已加载`);
})();