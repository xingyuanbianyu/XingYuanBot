import './lib.cjs'
import { WebSocket, WebSocketServer } from 'ws';
import { loadPlugins, clearPluginCache } from './plugin-loader.js';
import { getRole } from '../xy-config/config/permissions.js';
import config from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import http from 'http';
import axios from 'axios';
import { spawn } from 'child_process';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADAPTER_PORT = 9521;
const API_URL = 'http://127.0.0.1:3000';
const BRIDGE_JS = join(__dirname, 'bridge.js');

// ==================== 配置读取 ====================
function loadConfig(relativePath) {
    if (!relativePath) return {};
    try {
        const fullPath = path.join(__dirname, relativePath);
        if (fs.existsSync(fullPath)) {
            const fileContents = fs.readFileSync(fullPath, 'utf8');
            return YAML.parse(fileContents) || {};
        }
    } catch (e) {
        console.error(`❌ 读取配置 ${relativePath} 失败:`, e.message);
    }
    return {};
}

const serverCfg = loadConfig('../xy-data/bot_server.yaml');
const clientCfg = loadConfig('../xy-data/bot_client.yaml');

// 优先从 YAML 配置文件读取，没有则 fallback 到环境变量或默认值
const WS_PORT  = serverCfg.server?.port ?? Number(process.env.WS_PORT) ?? 3001;
const WS_HOST  = serverCfg.server?.host ?? process.env.WS_HOST ?? '127.0.0.1';

const clientHost = clientCfg.client?.host ?? process.env.CLIENT_HOST ?? '127.0.0.1';
const clientPort = clientCfg.client?.port ?? Number(process.env.CLIENT_PORT) ?? 3001;
const REMOTE_WS_URL = `ws://${clientHost}:${clientPort}`;

console.log(`[配置] 服务端监听: ${WS_HOST}:${WS_PORT}`);
console.log(`[配置] 客户端目标: ${REMOTE_WS_URL}`);

// 注册全局重载函数（供 index.js 中的重载指令调用）
globalThis._xyReloadPlugins = async () => {
    clearPluginCache();          // 先清缓存
    const plugins = await loadPlugins();  // 再重新加载
    return plugins;
};

// 消息分发：每次取 plugins 的最新引用，而不是闭包写死
async function dispatchMessage(msg) {
    const plugins = await loadPlugins();  // 这样拿到的始终是最新的
    for (const plugin of plugins) {
        // 匹配规则并执行 handler
    }
}

// ==================== 以下逻辑全部保持不变 ====================

let plugins = [];
let wsClient = null;
let wsServer = null;
let connected = false;
let clientTimer = null;
let currentMode = null;

// ===================== 全局状态：全进程唯一 =====================
const State = { IDLE: 0, CONNECTING: 1, CONNECTED: 2 };
const STATE_NAME = ['IDLE', 'CONNECTING', 'CONNECTED'];

let state = State.IDLE;          // 全局连接状态
let primaryChannel = null;       // 当前生效通道: 'client' | 'server'

/** 只有状态真正变化时才打日志，重复调用一律静默 */
function setState(next, reason = '') {
  if (state === next) return;
  const prev = state;
  state = next;
  const icon = next === State.CONNECTED ? '✅' : next === State.CONNECTING ? '🔄' : '⚪';
  console.log(`${icon} 通道状态 -> ${STATE_NAME[next]}${reason ? ' (' + reason + ')' : ''}`);
}

/** 抢占主通道：已被别人占了就返回 false，调用方必须立刻闭嘴退出 */
function claimPrimary(ch) {
  if (primaryChannel && primaryChannel !== ch) return false;
  primaryChannel = ch;
  return true;
}

/** 释放主通道，备胎可以接管 */
function releasePrimary(ch) {
  if (primaryChannel === ch) primaryChannel = null;
}

// ==================== 停止客户端重试 ====================
function stopClientRetry() {
    if (clientTimer) {
        clearTimeout(clientTimer);
        clientTimer = null;
    }
}

// ==================== 关闭服务端 ====================
function stopServer() {
    if (wsServer) {
        wsServer.close();
        wsServer = null;
        console.log('✅ 服务端已关闭');
    }
}

// ==================== 黑名单检查 ====================
function isBlacklisted(userId, groupId) {
    const qq = String(userId);
    const blacklistQQ = config.blacklist_qq || [];
    const blacklistGroup = config.blacklist_group || [];

    // QQ 号命中黑名单
    if (blacklistQQ.includes(qq)) {
        console.log(`🚫 黑名单拦截: QQ ${qq}`);
        return true;
    }

    // 群号命中黑名单
    if (groupId && blacklistGroup.includes(String(groupId))) {
        console.log(`🚫 黑名单拦截: 群 ${groupId}`);
        return true;
    }

    return false;
}

// ==================== 消息处理（两种模式共用） ====================
function setupMessageHandler(ws) {
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            // 🔴 只处理 message 和 notice
            if (msg.post_type !== 'message' && msg.post_type !== 'notice') return;

            // ─────────────────────────────────────
            // 【Notice 事件 → 走 event 类型插件】
            // ─────────────────────────────────────
            if (msg.post_type === 'notice') {
                console.log(`📡 收到通知事件: notice_type=${msg.notice_type}, sub_type=${msg.sub_type || '无'}`);

                // 黑名单检查
                const noticeUserId = msg.user_id || msg.operator_id;
                const noticeGroupId = msg.group_id;
                if (isBlacklisted(noticeUserId, noticeGroupId)) return;

                for (const { name, handler } of plugins) {
                    //if (!handler || typeof handler !== 'object') continue;
                    if (handler.type !== 'event') continue;
                    if (typeof handler.handle !== 'function') continue;

                    try {
                        const reply = await handler.handle({ text: '', msg });
                        if (reply && reply.text) {
                            const chatId = msg.group_id || msg.user_id;
                            const isGroup = !!msg.group_id;
                            await sendMsg(chatId, reply, isGroup);
                            console.log(`✅ 插件 [${name}] 回复成功`);
                        }
                    } catch (e) {
                        console.error(`❌ 插件 [${name}] 执行报错:`, e.message);
                    }
                }
                return;
            }

            // ─────────────────────────────────────
            // 【Message 事件 → 走常规文本插件】
            // ─────────────────────────────────────
            const isGroup = msg.message_type === 'group';
            const chatId = isGroup ? msg.group_id : msg.user_id;
            const senderName = msg.sender?.card || msg.sender?.nickname || '未知';
            const senderQQ = String(msg.user_id);
            const role = getRole(senderQQ);

            // 🔴 黑名单拦截
            if (isBlacklisted(senderQQ, isGroup ? msg.group_id : null)) return;

            let text = '';
            let replyMsgId = '';
            if (Array.isArray(msg.message)) {
                for (const seg of msg.message) {
                    if (seg.type === 'text') {
                        text += seg.data.text.trim();
                    } else if (seg.type === 'at') {
                        const atId = seg.data.qq || seg.data.id || seg.data.user_id;
                        text += `@[at:${atId}]`;
                    } else if (seg.type === 'reply') {
                        if (seg.data.text) {
                            text += `[引用:${seg.data.text}]`;
                        } else if (seg.data.id) {
                            text += `[引用ID:${seg.data.id}]`;
                        }
                    }
                }
            } else if (msg.raw_message) {
                text = msg.raw_message;
            } else if (typeof msg.message === 'string') {
                text = msg.message;
            }

            const preview = text.length > 30 ? text.substring(0, 30) + '...' : text;
            if (isGroup) {
                console.log(`[收] 群聊 [群号: ${chatId}] ${senderName}: ${preview}`);
            } else {
                console.log(`[收] 私聊 [QQ: ${chatId}] ${senderName}: ${preview}`);
            }

            for (const { name, handler } of plugins) {
                if (!handler || typeof handler !== 'object') continue;
                if (typeof handler.match !== 'function') continue;

                try {
                    if (handler.match(text)) {
                        const reply = await handler.handle({
                            text,
                            chatId,
                            isGroup,
                            senderName,
                            senderQQ,
                            role,
                            replyMsgId,
                            msg,
                        });
                        if (reply) {
                            await sendMsg(chatId, reply, isGroup);
                        }
                        break;
                    }
                } catch (e) {
                    console.error(`❌ 插件 [${name}] 执行报错:`, e.message);
                }
            }
        } catch (e) {
            console.error('❌ 消息处理出错:', e);
        }
    });
}
// ========== 启动 bridge.js ==========
function startBridgeJs() {
    console.log('[adapter.js] 启动 bridge.js ...');
    const proc = spawn('node', [BRIDGE_JS], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
    });
    proc.stdout.on('data', d => process.stdout.write(`[bridge.js] ${d}`));
    proc.stderr.on('data', d => process.stderr.write(`[bridge.js] ${d}`));
    proc.on('close', code => {
        console.log(`[adapter.js] bridge.js 退出, 代码: ${code}, 5秒后重启...`);
        setTimeout(startBridgeJs, 5000);
    });
}

// ========== 启动 HTTP 接收服务（收 bridge.js 的转发） ==========
http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const parsed = JSON.parse(body);
            const group_id = parsed.group_id;
            const message = parsed.message;
            // user_id 如果 bridge 没传，就给个空字符串，避免报错
            const user_id = parsed.user_id ? String(parsed.user_id) : '';

            // ====== 黑名单拦截 ======
            const blacklistQQ = config.blacklist_qq || [];
            const blacklistGroup = config.blacklist_group || [];

            if (user_id && blacklistQQ.includes(user_id)) {
                console.log(`🚫 黑名单拦截: QQ ${user_id}`);
                res.writeHead(403);
                res.end(JSON.stringify({ status: 'blocked' }));
                return;  // 终止，不发送
            }

            if (blacklistGroup.includes(String(group_id))) {
                console.log(`🚫 黑名单拦截: 群 ${group_id}`);
                res.writeHead(403);
                res.end(JSON.stringify({ status: 'blocked' }));
                return;  // 终止，不发送
            }

            // ====== 黑名单拦截结束 ======

            const result = await axios.post(`${API_URL}/send_group_msg`, {
                group_id,
                message
            });

            if (result.data?.status === 'ok') {
                console.log(`[adapter.js] ✅ 发送成功`);
                res.writeHead(200); res.end('{"status":"ok"}');
            } else {
                console.log(`[adapter.js] ❌ 发送失败: ${result.data?.msg}`);
                res.writeHead(500); res.end('{"error":"send failed"}');
            }
        } catch (e) {
            console.error(`[adapter.js] 异常: ${e.message}`);
            res.writeHead(500); res.end('{"error":"internal"}');
        }
    });
}).listen(ADAPTER_PORT, () => {
    console.log(`[adapter.js] 🟢 监听端口: ${ADAPTER_PORT}`);
    startBridgeJs();  // 端口就绪后拉起 bridge.js
});
// ==================== 发送消息 ====================
export async function sendMsg(chatId, reply, isGroup) {
    if (!wsClient) return;

    let messageSegs = [];

    if (reply && typeof reply === 'object' && reply.file) {
        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        const fileName = 'pub.png';
        const filePath = path.join(tempDir, fileName);
        const buffer = Buffer.from(reply.file.file);
        fs.writeFileSync(filePath, buffer);

        messageSegs.push({ type: 'image', data: { file: filePath } });
        console.log(`[发] [${isGroup ? '群' : '私'} ${chatId}]: [图片]`);
    } else {
        const replyStr = reply && reply.text ? reply.text : String(reply);
        messageSegs.push({ type: 'text', data: { text: replyStr } });

        const rPreview = replyStr.length > 30 ? replyStr.substring(0, 30) + '...' : replyStr;
        console.log(`[发] [${isGroup ? '群' : '私'} ${chatId}]: ${rPreview}`);
    }

    const payload = {
        action: 'send_msg',
        params: {
            message_type: isGroup ? 'group' : 'private',
            [isGroup ? 'group_id' : 'user_id']: chatId,
            message: messageSegs,
        },
    };

    wsClient.send(JSON.stringify(payload));
}

// ===================== 客户端：被占就静默退出 =====================
async function tryConnectClient(attempt = 1) {
  // ⬇️ 关键第一条：已经有人连上了，我直接闭嘴，不重试、不打日志
  if (state === State.CONNECTED && primaryChannel !== 'client') return;

  setState(State.CONNECTING, 'client');

  try {
    const ws = new WebSocket(REMOTE_WS_URL);
    await new Promise((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    // ⬇️ 关键第二条：抢锁，抢不到说明服务端已经先连上了，我主动关掉自己
    if (!claimPrimary('client')) {
      console.log('⚪ 服务端通道已在运行，客户端自动让位并关闭');
      ws.close();
      return;
    }

    setState(State.CONNECTED, 'client');
    wsClient = ws;
    setupMessageHandler(ws);

    ws.on('close', () => {
      console.log('⚠️ 客户端通道断开');
      wsClient = null;
      releasePrimary('client');
      setState(State.IDLE, 'client lost');
      stopClientRetry();
      // 只有自己断了才重连，不会和服务端打架
      tryConnectClient(1);
    });

  } catch (err) {
    releasePrimary('client');
    // ⬇️ 关键第三条：失败日志只在第一次和状态变化时打，之后指数退避 + 静默
    if (attempt <= 2) {
      console.log(`❌ 客户端连接失败 (${attempt}/3): ${err.message}`);
    }
    const delay = Math.min(2000 * Math.pow(2, attempt - 1), 60000); // 2s / 4s / 8s ... 上限60s
    clientTimer = setTimeout(() => tryConnectClient(attempt + 1), delay);
  }
}

// ===================== 服务端：监听本身不产生日志 =====================
function startServer() {
  if (wsServer) return; // 防重复启动，避免 EADDRINUSE

  wsServer = new WebSocketServer({ port: WS_PORT, host: WS_HOST });
  console.log(`🌐 服务端开始监听 ${WS_HOST}:${WS_PORT}`);

  wsServer.on('connection', (ws) => {
    // ⬇️ 客户端已经连上了，新来的直接拒绝，不刷屏
    if (primaryChannel === 'client') {
      ws.close(1000, 'primary channel active');
      return;
    }
    if (!claimPrimary('server')) { ws.close(); return; }

    setState(State.CONNECTED, 'server');
    wsClient = ws;
    setupMessageHandler(ws);

    ws.on('close', () => {
      console.log('⚠️ 服务端通道断开，继续监听...');
      wsClient = null;
      releasePrimary('server');
      setState(State.IDLE, 'server lost');
      // 服务端不用重连，继续 listen 就行 —— 这一行不会产生任何循环日志
    });
  });
}

// ==================== 启动入口 ====================
export async function connectOneBot() {
    plugins = await loadPlugins();
    console.log(`📦 已加载 ${plugins.length} 个插件`);

    startServer();
    tryConnectClient(1);
}