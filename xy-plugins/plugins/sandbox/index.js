import fs from 'fs';
import path from 'path';
import os from 'os'; // 🌟 新增：获取本地网卡信息
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import vm from 'vm';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { hasPermission } from '../../../xy-config/config/permissions.js'; // 记得确认路径对不对

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'web.html');

// 状态池
const servers = new Map();  
const localSessions = new Map();

// ==========================================
// 🌟 核心修复：补齐工具函数
// ==========================================
const generateToken = () => crypto.randomBytes(8).toString('hex');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '127.0.0.1'; // 找不到就回环
}

function checkPort(port) {
    try {
        // 兼容 Windows 和 Linux 的端口占用检测
        const cmd = process.platform === 'win32' 
            ? `netstat -ano | findstr :${port}` 
            : `lsof -i:${port} || ss -ltn | grep :${port}`;
        execSync(cmd, { stdio: 'ignore' });
        return false; // 有输出说明被占用
    } catch (e) {
        return true; // 报错说明没被占用（findstr/grep 没找到会返回非0退出码）
    }
}

export default {
    name: 'Web沙盒',
    
    match(text) {
        if (typeof text !== 'string') return false;
        return text.trim() === '启动沙盒' || text.trim() === '关闭沙盒';
    },

    async handle(msg) {
        const text = (msg.pureText || msg.content || "").trim();
        const senderQQ = String(msg.senderQQ || '');
        if (!senderQQ) return null;

        // 权限校验
        if (!hasPermission(senderQQ, 'master')) {
            if (text === '启动沙盒' || text === '关闭沙盒') return '❌ 权限不足：该指令仅限大主人使用。';
            return null; 
        }

        // 关闭沙盒
        if (text === '关闭沙盒') {
            if (servers.has(senderQQ)) {
                const srvObj = servers.get(senderQQ);
                srvObj.http.close();
                if (srvObj.wss) srvObj.wss.close();
                servers.delete(senderQQ);
                return { content: '✅ 沙盒已成功关闭。', __interceptNext: false };
            }
            return { content: '❌ 当前没有运行中的沙盒。', __interceptNext: false };
        }

        // 启动沙盒
        if (text === '启动沙盒') {
            if (servers.has(senderQQ)) return { content: '❌ 你已经有一个运行中的沙盒了，请先关闭。', __interceptNext: false };
            localSessions.set(senderQQ, { step: 'protocol' });
            return { 
                content: '🌟 启动沙盒！\n请选择网络协议（回复数字 1-4）：\n1. ws\n2. wss\n3. http\n4. https',
                __interceptNext: true 
            };
        }

        // 长查询状态机
        const session = localSessions.get(senderQQ);
        if (session) {
            if (session.step === 'protocol') {
                const map = { '1': 'ws', '2': 'wss', '3': 'http', '4': 'https' };
                if (!map[text]) return { content: '❌ 输入错误，请回复数字 1-4：\n1. ws\n2. wss\n3. http\n4. https', __interceptNext: true };
                session.protocol = map[text];
                session.step = 'host';
                return { 
                    content: `✅ 已选择协议：${session.protocol}\n请选择监听地址（回复数字 1-3）：\n1. 本地回环 (127.0.0.1)\n2. 外网 (0.0.0.0)\n3. 内网 (局域网IP)`,
                    __interceptNext: true 
                };
            }

            if (session.step === 'host') {
                const map = { '1': '127.0.0.1', '2': '0.0.0.0', '3': getLocalIP() };
                if (!map[text]) return { content: '❌ 输入错误，请回复数字 1-3', __interceptNext: true };
                session.host = map[text];
                session.step = 'port';
                return { 
                    content: `✅ 已选择地址：${session.host}\n请输入监听端口（如 8080）：`,
                    __interceptNext: true 
                };
            }

            if (session.step === 'port') {
                const port = parseInt(text, 10);
                if (isNaN(port) || port < 1 || port > 65535) {
                    return { content: '❌ 端口格式错误，请输入 1-65535：', __interceptNext: true };
                }
                if (!checkPort(port)) {
                    return { content: `❌ 端口 ${port} 已被占用，请重新输入：`, __interceptNext: true };
                }

                session.port = port;
                session.token = generateToken();
                
                try {
                    const isHttps = session.protocol.includes('https') || session.protocol.includes('wss');
                    let httpServer;

                    // 请求处理函数（返回 HTML）
                    const requestHandler = (req, res) => {
                        const url = new URL(req.url, `http://${req.headers.host}`);
                        if (url.pathname === '/') {
                            if (url.searchParams.get('token') !== session.token) {
                                res.writeHead(403);
                                return res.end('Forbidden: Invalid Token');
                            }
                            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                            res.end(fs.readFileSync(htmlPath));
                        } else {
                            res.writeHead(404);
                            res.end('Not Found');
                        }
                    };

                    // 启动 HTTP/HTTPS
                    if (isHttps) {
                        try {
                            const options = {
                                key: fs.readFileSync(path.join(__dirname, 'key.pem')),
                                cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
                            };
                            const httpsMod = await import('https');
                            httpServer = httpsMod.createServer(options, requestHandler);
                        } catch (e) {
                            localSessions.delete(senderQQ);
                            return { content: '❌ 缺少 HTTPS 证书！请在插件目录下放置 key.pem 和 cert.pem。', __interceptNext: false };
                        }
                    } else {
                        const httpMod = await import('http');
                        httpServer = httpMod.createServer(requestHandler);
                    }

                    // 启动 WebSocket
                    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
                    wss.on('connection', (ws, req) => {
                        const url = new URL(req.url, `http://${req.headers.host}`);
                        if (url.searchParams.get('token') !== session.token) {
                            ws.close();
                            return;
                        }

                        ws.on('message', async (message) => {
                            try {
                                const data = JSON.parse(message);
                                if (data.type === 'exec') {
                                    // 沙盒引擎
                                    const sandbox = {
                                        ...globalThis, // 允许访问全局
                                        console: {
                                            log: (...args) => ws.send(JSON.stringify({ type: 'result', output: args.join(' '), success: true })),
                                            error: (...args) => ws.send(JSON.stringify({ type: 'result', output: args.join(' '), success: false }))
                                        },
                                        print: (...args) => ws.send(JSON.stringify({ type: 'result', output: args.join(' '), success: true })),
                                        setTimeout, clearTimeout
                                    };
                                    const context = vm.createContext(sandbox);
                                    const result = vm.runInContext(data.code, context, { timeout: 3000 });
                                    ws.send(JSON.stringify({ type: 'result', output: result !== undefined ? String(result) : 'undefined', success: true }));
                                }
                            } catch (err) {
                                ws.send(JSON.stringify({ type: 'result', output: err.message, success: false }));
                            }
                        });
                    });

                    // 监听端口
                    httpServer.listen(session.port, session.host, () => {
                        servers.set(senderQQ, { http: httpServer, wss });
                        localSessions.delete(senderQQ); // 清理状态，解除长查询拦截
                        
                        const accessHost = session.host === '0.0.0.0' ? getLocalIP() : session.host;
                        const webProto = isHttps ? 'https' : 'http';
                        const finalUrl = `${webProto}://${accessHost}:${session.port}/?token=${session.token}`;
                        
                        globalThis.bot.send({
                            chatId: msg.chatId,
                            isGroup: msg.isGroup,
                            content: `✅ 沙盒启动成功！\n协议：${session.protocol}\n监听：${session.host}:${session.port}\n\n🔗 专属访问链接：\n${finalUrl}\n\n⚠️ 警告：此链接拥有服务器最高控制权，切勿泄露！`
                        });
                    });

                    // 返回 false 解除拦截
                    return { content: null, __interceptNext: false };

                } catch (err) {
                    localSessions.delete(senderQQ);
                    return { content: `❌ 启动服务器失败：${err.message}`, __interceptNext: false };
                }
            }
        }
        return null;
    }
};