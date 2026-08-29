import { WebSocket, WebSocketServer } from 'ws';
import { loadPlugins } from './plugin-loader.js';
import { getRole } from '../xy-config/config/permissions.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 配置 ====================
const WS_SERVER_PORT = process.env.WS_SERVER_PORT || 3001; // 服务端监听端口
const WS_CLIENT_PORT = process.env.WS_CLIENT_PORT || 3004; // 客户端连接端口
const REMOTE_WS_URL = process.env.REMOTE_WS_URL || `ws://127.0.0.1:${WS_CLIENT_PORT}`;
const AI_DATA_API = 'http://127.0.0.1:8080/receive';

let plugins = [];
let wsClient = null;
let wsServer = null;
let clientTimer = null;

// ==================== 🔴 向 Python 项目静默发送数据 ====================
async function sendDataToAI(text, senderName, chatId, isGroup) {
    if (!text.trim()) return;
    try {
        fetch(AI_DATA_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                time: new Date().toISOString(),
                chatId: chatId,
                isGroup: isGroup,
                sender: senderName,
                text: text
            })
        }).catch(() => {});
    } catch (error) {}
}

// ==================== 清理函数 ====================

function stopClientRetry() {
    if (clientTimer) {
        clearTimeout(clientTimer);
        clientTimer = null;
        console.log('🛑 客户端重连任务已停止');
    }
}

function stopServer() {
    if (wsServer) {
        wsServer.close(() => {
            console.log('🛑 本地服务端已关闭');
        });
        wsServer = null;
    }
}

// ==================== 消息处理（通用） ====================
function setupMessageHandler(ws) {
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.post_type !== 'message' && msg.post_type !== 'notice') return;

            if (msg.post_type === 'notice') {
                console.log(`📡 收到通知事件: ${msg.notice_type}`);
                for (const { name, handler } of plugins) {
                    if (handler?.type === 'event' && typeof handler.handle === 'function') {
                        try {
                            const reply = await handler.handle({ text: '', msg });
                            if (reply && reply.text) {
                                const chatId = msg.group_id || msg.user_id;
                                await sendMsg(chatId, reply, !!msg.group_id);
                            }
                        } catch (e) { console.error(`❌ 插件 [${name}] 报错:`, e.message); }
                    }
                }
                return;
            }

            const isGroup = msg.message_type === 'group';
            const chatId = isGroup ? msg.group_id : msg.user_id;
            const senderName = msg.sender?.card || msg.sender?.nickname || '未知';
            const senderQQ = String(msg.user_id);
            const role = getRole(senderQQ);

            let text = '';
            if (Array.isArray(msg.message)) {
                for (const seg of msg.message) {
                    if (seg.type === 'text') text += seg.data.text.trim();
                    else if (seg.type === 'at') text += `@[at:${seg.data.qq || seg.data.id}]`;
                    else if (seg.type === 'reply') {
                        const refId = seg.data?.id || seg.data?.message_id;
                        text += `[引用ID:${refId}]`;
                    }
                }
            } else {
                text = msg.raw_message || msg.message || '';
            }

            const preview = text.length > 30 ? text.substring(0, 30) + '...' : text;
            console.log(`[收] [${isGroup ? '群' : '私'}] ${senderName}: ${preview}`);

            sendDataToAI(text, senderName, chatId, isGroup);

            for (const { name, handler } of plugins) {
                if (handler?.match && typeof handler.match === 'function' && handler.match(text)) {
                    try {
                        const reply = await handler.handle({
                            text, chatId, isGroup, senderName, senderQQ, role, msg,
                        });
                        if (reply) await sendMsg(chatId, reply, isGroup);
                        break;
                    } catch (e) { console.error(`❌ 插件 [${name}] 报错:`, e.message); }
                }
            }
        } catch (e) { console.error('❌ 消息解析错误:', e); }
    });

    ws.on('close', () => {
        console.log('🔌 连接已断开，准备重置状态...');
        wsClient = null;
        if (!wsServer) startServer();
        if (!clientTimer) tryConnectClient(1);
    });
}

// ==================== 发送消息 ====================
export async function sendMsg(chatId, reply, isGroup) {
    if (!wsClient) return;
    let messageSegs = [];

    if (reply && typeof reply === 'object' && reply.file) {
        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        const filePath = path.join(tempDir, 'pub.png');
        fs.writeFileSync(filePath, Buffer.from(reply.file.file));
        messageSegs.push({ type: 'image', data: { file: filePath } });
    } else {
        const replyStr = reply && reply.text ? reply.text : String(reply);
        messageSegs.push({ type: 'text', data: { text: replyStr } });
    }

    const payload = {
        action: 'send_msg',
        params: {
            message_type: isGroup ? 'group' : 'private',
            [isGroup ? 'group_id' : 'user_id']: chatId,
            message: messageSegs,
        },
    };
    try {
        wsClient.send(JSON.stringify(payload));
    } catch (e) { console.error('发送失败，连接可能已断开'); }
}

// ==================== 客户端模式：主动连接 ====================
async function tryConnectClient(retryCount) {
    if (wsClient) return;

    if (retryCount > 3) {
        clientTimer = setTimeout(() => { tryConnectClient(1); }, 3 * 60 * 1000);
        return;
    }

    try {
        console.log(`🔌 正在尝试连接远程服务端: ${REMOTE_WS_URL} (尝试次数: ${retryCount})`);
        const ws = new WebSocket(REMOTE_WS_URL);

        await new Promise((resolve, reject) => {
            ws.on('open', () => resolve());
            ws.on('error', (err) => reject(err));
            setTimeout(() => reject(new Error('timeout')), 5000);
        });

        wsClient = ws;
        console.log(`✅ 客户端模式激活：已连接到 ${REMOTE_WS_URL}`);

        // 连上了远程服务端，关闭本地服务端
        stopServer();

        setupMessageHandler(ws);

    } catch (err) {
        console.log(`连接失败: ${err.message}`);
        await new Promise(r => setTimeout(r, 2000));
        tryConnectClient(retryCount + 1);
    }
}

// ==================== 服务端模式：被动监听 ====================
function startServer() {
    if (wsServer) return;

    wsServer = new WebSocketServer({ port: WS_SERVER_PORT });
    console.log(`📡 服务端模式激活：正在监听端口 ${WS_SERVER_PORT}，等待连接...`);

    wsServer.on('connection', (ws) => {
        console.log(`✅ 服务端收到连接：远程客户端已接入`);

        // 被连上了，停止主动重连
        stopClientRetry();

        if (wsClient && wsClient !== ws) {
            wsClient.terminate();
        }

        wsClient = ws;
        setupMessageHandler(ws);
    });

    wsServer.on('error', (err) => {
        console.error('服务端启动失败:', err.message);
    });
}

// ==================== 启动入口 ====================
export async function connectOneBot() {
    plugins = await loadPlugins();
    console.log(`📦 已加载 ${plugins.length} 个插件`);

    startServer();
    tryConnectClient(1);
}
