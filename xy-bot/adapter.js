// xy-bot/adapter.js
import { WebSocket, WebSocketServer } from 'ws';
import axios from 'axios';
import { parseMessage, parseMemberEvent, MSG } from './message.js';

let eventHandler = null;  // 由外部注入（eventBus 的 emit）

export function setEventHandler(handler) {
  eventHandler = handler;
}

// 支持 server/client 双模式
export async function connectOneBot(config) {
  const { mode, port, wsUrl, apiUrl } = config;

  if (mode === 'server') {
    return startServer(port, apiUrl);
  } else if (mode === 'client') {
    return startClient(wsUrl, apiUrl);
  } else {
    throw new Error(`未知的 mode: ${mode}，只支持 'server' 或 'client'`);
  }
}

// ===== 服务端模式（反向 WS）=====
function startServer(port, apiUrl) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port });
    console.log(`👂 [Server] 监听端口 ${port}，等待 NapCatQQ 连接...`);

    wss.on('connection', (ws) => {
      console.log('✅ [Server] NapCatQQ 已连接');
      wireWebSocket(ws, apiUrl, 'server');
      resolve({ ws, apiUrl, mode: 'server', close: () => wss.close() });
    });

    setTimeout(() => reject(new Error(`超时：NapCatQQ 未在30秒内连接端口 ${port}`)), 30000);
  });
}

// ===== 客户端模式（正向 WS）=====
async function startClient(wsUrl, apiUrl) {
  const ws = new WebSocket(wsUrl);
  console.log(`🔌 [Client] 正在连接 ${wsUrl}...`);

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log(`✅ [Client] 已连接到 ${wsUrl}`);
      wireWebSocket(ws, apiUrl, 'client');
      resolve({ ws, apiUrl, mode: 'client', close: () => ws.close() });
    });
    ws.on('error', (e) => reject(e));
    setTimeout(() => reject(new Error(`超时：未能连接到 ${wsUrl}`)), 30000);
  });
}

// ===== 消息处理（统一转换 → 推送）=====
function wireWebSocket(ws, apiUrl, mode) {
  ws.on('message', async (rawData) => {
    try {
      const data = JSON.parse(rawData);
      const raw = wrapData(data);  // 确保是对象

      // 消息事件
      if (raw.post_type === 'message' || raw.post_type === 'message_sent') {
        const stdMsg = parseMessage(raw);
        if (eventHandler) await eventHandler(stdMsg);
        return;
      }

      // 群通知事件
      if (raw.post_type === 'notice') {
        const stdEvt = parseMemberEvent(raw.notice_type, raw);
        if (stdEvt && eventHandler) await eventHandler(stdEvt);
        return;
      }
    } catch (e) {
      console.error('解析消息失败:', e.message);
    }
  });
}

function wrapData(data) {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return { text: data }; }
  }
  return data || {};
}

// ===== 发送消息（统一格式 → 转回 OneBot 格式）=====
export async function sendQQMessage(adapter, chatId, segments, chatType) {
  const api = chatType === 'group' ? '/send_group_msg' : '/send_private_msg';
  const body = {
    [chatType === 'group' ? 'group_id' : 'user_id']: Number(chatId),
    message: toOneBotSegments(segments),
  };

  try {
    const res = await axios.post(adapter.apiUrl + api, body);
    return res.data?.data?.message_id;
  } catch (e) {
    console.error('发送QQ消息失败:', e.message);
    return null;
  }
}

// 把统一格式转回 OneBot 格式发送
function toOneBotSegments(segments) {
  if (!Array.isArray(segments)) segments = [segments];
  return segments.map(seg => {
    if (seg.type === 'at') return { type: 'at', data: { qq: seg.data.userId } };
    if (seg.type === 'reply') return { type: 'reply', data: { id: seg.data.messageId } };
    // text, image, face 直接透传
    return { type: seg.type, data: seg.data };
  });
}
