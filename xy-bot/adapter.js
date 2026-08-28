import { WebSocket, WebSocketServer } from 'ws';
import { loadPlugins } from './plugin-loader.js';
import { getRole } from '../xy-config/config/permissions.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 配置 ====================
const WS_PORT = process.env.WS_PORT || 3001;
const REMOTE_WS_URL = process.env.REMOTE_WS_URL || 'ws://127.0.0.1:3001';

let plugins = [];
let wsClient = null;
let wsServer = null;
let connected = false;
let clientTimer = null;

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

                for (const { name, handler } of plugins) {
                    // 🔴 先确认 handler 是个对象，且有 type 和 handle
                    if (!handler || typeof handler !== 'object') continue;
                    if (handler.type !== 'event') continue;
                    if (typeof handler.handle !== 'function') continue;

                    try {
                        const reply = await handler.handle({ text: '', msg });
                        if (reply && reply.text) {
                            // notice 事件没有 chatId，需要从 msg 中取
                            const chatId = msg.group_id || msg.user_id;
                            const isGroup = !!msg.group_id;
                            await sendMsg(chatId, reply, isGroup);
                            console.log(`✅ 插件 [${name}] 回复成功`);
                        }
                    } catch (e) {
                        console.error(`❌ 插件 [${name}] 执行报错:`, e.message);
                    }
                }
                return; // notice 处理完就结束，不走下面的 message 逻辑
            }

            // ─────────────────────────────────────
            // 【Message 事件 → 走常规文本插件】
            // ─────────────────────────────────────
            const isGroup = msg.message_type === 'group';
            const chatId = isGroup ? msg.group_id : msg.user_id;
            const senderName = msg.sender?.card || msg.sender?.nickname || '未知';
            const senderQQ = String(msg.user_id);
            const role = getRole(senderQQ);

            // 提取文本
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
            console.log(`[收] [${isGroup ? '群' : '私'}] ${senderName}: ${preview}`);

            // 遍历插件匹配
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

// ==================== 客户端模式：主动去连 ====================
async function tryConnectClient(retryCount) {
    if (connected) return;
    if (retryCount > 3) {
        console.log(`⚠️  客户端连接失败已达3次，静默等待3分钟后重试...`);
        clientTimer = setTimeout(() => { tryConnectClient(1); }, 3 * 60 * 1000);
        return;
    }

    console.log(`🔄 客户端尝试连接 ${REMOTE_WS_URL}... (第 ${retryCount}/3 次)`);

    try {
        const ws = new WebSocket(REMOTE_WS_URL);

        await new Promise((resolve, reject) => {
            ws.on('open', () => { resolve(); });
            ws.on('error', (err) => { reject(err); });
            setTimeout(() => reject(new Error('timeout')), 5000);
        });

        connected = true;
        wsClient = ws;
        console.log(`✅ 客户端已连接: ${REMOTE_WS_URL}`);

        setupMessageHandler(ws);
        stopServer();

    } catch (err) {
        console.log(`❌ 第 ${retryCount} 次连接失败: ${err.message}`);
        await new Promise(r => setTimeout(r, 2000));
        tryConnectClient(retryCount + 1);
    }
}

// ==================== 服务端模式：等待被连 ====================
function startServer() {
    wsServer = new WebSocketServer({ port: WS_PORT });
    console.log(`📡 服务端已启动，监听端口 ${WS_PORT}...`);
    console.log(`   等待 NapCat 或其他客户端连接...`);

    wsServer.on('connection', (ws) => {
        if (connected) {
            console.log('⚠️  已有连接，拒绝新连接');
            ws.close();
            return;
        }

        connected = true;
        wsClient = ws;
        console.log(`✅ 客户端已连接（服务端模式）`);

        setupMessageHandler(ws);
        stopClientRetry();
    });
}

// ==================== 启动入口 ====================
export async function connectOneBot() {
    plugins = await loadPlugins();
    console.log(`📦 已加载 ${plugins.length} 个插件`);

    startServer();
    tryConnectClient(1);
}
