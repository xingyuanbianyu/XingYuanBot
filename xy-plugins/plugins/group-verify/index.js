import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import Database from 'better-sqlite3'; // 🌟 强烈建议换成 sqlite3，别用 globalThis.db 魔法
import { fileURLToPath } from 'url';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const DB_PATH = path.join(__dirname, 'verify_data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS verify_settings (
    group_id TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    verify_type TEXT DEFAULT 'math'
  )
`);

const pendingVerifications = new Map();
let verifyBrowser = null;

export default {
  name: '入群验证',
  events: ['group.increase'],

  loadConfig() {
    try { return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) { return {}; }
  },

  getGroupSettings(groupId) {
    const defaults = { enabled: 0, verify_type: this.loadConfig().verify_type || 'math' };
    try {
        const row = db.prepare('SELECT * FROM verify_settings WHERE group_id = ?').get(String(groupId));
        if (row) {
            return { enabled: row.enabled, verify_type: row.verify_type || defaults.verify_type };
        }
    } catch (e) {}
    return defaults;
  },

  setGroupSetting(groupId, key, value) {
    try {
        const gid = String(groupId);
        db.prepare(`
            INSERT INTO verify_settings (group_id, ${key}) VALUES (?, ?)
            ON CONFLICT(group_id) DO UPDATE SET ${key} = excluded.${key}
        `).run(gid, value);
        return true;
    } catch (e) { return false; }
  },

  formatMsg(template, data = {}) {
    if (!template) return '';
    let str = template;
    for (const [key, value] of Object.entries(data)) {
        str = str.replace(new RegExp(`{${key}}`, 'g'), value);
    }
    return str;
  },

  // 🌟 修复：把 msg 传进来，作为双保险
  match(text, msg) {
    if (typeof text !== 'string') return false;
    const cmd = text.trim();
    
    if (['开启入群验证', '关闭入群验证', '切换算术题', '切换文本验证', '切换图片验证', '入群验证帮助', '验证帮助', '入群申请帮助', '申请帮助'].includes(cmd)) return true;
    if (cmd.startsWith('跳过验证') || cmd.startsWith('重新验证')) return true;

    // 双保险：如果该用户在验证状态中，放行他的所有消息
    if (msg && msg.isGroup) {
        const key = `${msg.chatId}_${msg.senderQQ}`;
        if (pendingVerifications.has(key)) return true;
    }
    return false;
  },

  async generateCaptchaImage(answer) {
    // ... (保留你原来的渲染代码，为了篇幅这里直接折叠)
    try {
        let chromium = null;
        try { chromium = (await import('playwright')).chromium; } catch (e) {
            try { chromium = (await import('puppeteer')).default || (await import('puppeteer')); } catch (e2) {}
        }
        if (!chromium) throw new Error("无浏览器内核");

        if (!verifyBrowser || !verifyBrowser.isConnected()) {
            verifyBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        }

        const html = `
        <html>
        <head>
            <style>
                body { margin: 0; padding: 0; background: transparent; display: flex; justify-content: center; align-items: center; height: 100vh; }
                .captcha-box { position: relative; width: 160px; height: 60px; background: linear-gradient(135deg, #2b2b36, #1e1e24); border-radius: 8px; overflow: hidden; display: flex; justify-content: center; align-items: center; box-shadow: inset 0 0 20px rgba(0,0,0,0.5); }
                .text { font-family: "Courier New", Courier, monospace; font-size: 32px; font-weight: bold; color: #fff; letter-spacing: 6px; z-index: 2; text-shadow: 2px 2px 4px rgba(0,0,0,0.8); user-select: none; }
                .char { display: inline-block; }
                .line { position: absolute; width: 200%; height: 2px; background: rgba(255,255,255,0.2); top: 50%; left: -50%; z-index: 1; }
                .line1 { transform: rotate(25deg); } .line2 { transform: rotate(-15deg); top: 30%; } .line3 { transform: rotate(60deg); top: 70%; }
            </style>
        </head>
        <body><div class="captcha-box"><div class="line line1"></div><div class="line line2"></div><div class="line line3"></div><div class="text">${answer.split('').map(c => `<span class="char" style="transform: rotate(${Math.random() * 40 - 20}deg) translateY(${Math.random() * 10 - 5}px);">${c}</span>`).join('')}</div></div></body>
        </html>
        `;

        const context = await verifyBrowser.newContext({ deviceScaleFactor: 3 });
        try {
            const page = await context.newPage();
            await page.setContent(html, { waitUntil: 'networkidle' });
            const captchaElement = await page.$('.captcha-box');
            return await captchaElement.screenshot({ type: 'png', omitBackground: true });
        } finally {
            await context.close().catch(()=>{});
        }
    } catch (e) {
        console.error('生成图片验证码失败:', e.message);
        return null;
    }
  },

  // 🌟 修复：加入 ws 参数，确保下发通知精准
  async startVerification(groupId, userId, nickname, ws) {
    const config = this.loadConfig();
    const settings = this.getGroupSettings(groupId);
    const timeout = (config.timeout || 120) * 1000;
    
    let verifyType = settings.verify_type;
    let answer, questionText;
    let imageBuffer = null;

    if (verifyType === 'image') {
        const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        answer = Array.from({length: 4}, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
        imageBuffer = await this.generateCaptchaImage(answer);
        questionText = imageBuffer ? `请识别并发送图片中的验证码：\n(⚠️ 注意：严格区分大小写！)` : `请发送验证码：${answer}\n(⚠️ 注意：严格区分大小写！)`;
        if (!imageBuffer) verifyType = 'text';
    } else if (verifyType === 'text') {
        const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        answer = Array.from({length: 4}, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
        questionText = `请发送验证码：${answer}\n(⚠️ 注意：严格区分大小写！)`;
    } else {
        const a = Math.floor(Math.random() * 20) + 1;
        const b = Math.floor(Math.random() * 20) + 1;
        answer = String(a + b);
        questionText = `请回答：${a} + ${b} = ?`;
    }

    const msgs = config.messages || {};
    const welcomeMsg = [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text: `\n${this.formatMsg(msgs.question_prompt || "请在 {timeout} 秒内回答下面的问题：", { timeout: config.timeout || 120 })}\n` } }
    ];

    if (imageBuffer) {
        welcomeMsg.push({ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } });
        welcomeMsg.push({ type: 'text', data: { text: `\n${msgs.warning || "(答题期间发送其他内容会被撤回，连续答错或超时将被踢出)"}` } });
    } else {
        welcomeMsg.push({ type: 'text', data: { text: questionText } });
        welcomeMsg.push({ type: 'text', data: { text: `\n${msgs.warning || "(答题期间发送其他内容会被撤回，连续答错或超时将被踢出)"}` } });
    }

    try {
        // 🌟 加上 ws 参数
        await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: welcomeMsg }, 5000, ws);
    } catch (err) {}

    const key = `${groupId}_${userId}`;
    if (pendingVerifications.has(key)) clearTimeout(pendingVerifications.get(key).timer);

    // 🌟 核心修复：使用 this.name 动态塞入名字，杜绝硬编码！
    if (globalThis._interactiveSessions) {
        globalThis._interactiveSessions.set(String(userId), { 
            pluginName: this.name, // 👈 就是这里！
            expireAt: Date.now() + timeout 
        });
    }

    const timer = setTimeout(async () => {
        try {
            await globalThis.wsCall('set_group_kick', { group_id: Number(groupId), user_id: Number(userId), reject_add_request: true }, 5000, ws);
            const kickText = msgs.timeout_kick || "⏰ 用户 {nickname}({userId}) 未在规定时间内完成验证，已自动踢出。";
            await globalThis.wsCall('send_group_msg', {
                group_id: Number(groupId),
                message: [{ type: 'text', data: { text: this.formatMsg(kickText, { nickname, userId }) } }]
            }, 5000, ws);
        } catch (err) {}
        pendingVerifications.delete(key);
        if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(String(userId));
    }, timeout);

    pendingVerifications.set(key, { answer, expireAt: Date.now() + timeout, timer, wrongCount: 0, nickname });
  },

  async onEvent(e, conn) {
    if (this.loadConfig().enabled === false) return; 
    if (e.event !== 'group.increase') return;

    const groupId = Number(e.groupId);
    const userId = Number(e.userId);
    
    // 🌟 修复：从 sharedState 找对应的 ws
    const selfId = String(e.selfId || e.raw?.self_id || '');
    if (userId === Number(selfId)) return;
    
    const settings = this.getGroupSettings(groupId);
    if (settings.enabled !== 1) return;

    let ws = conn?.ws;
    if (!ws && selfId && globalThis.sharedState?.botIdToWs) {
        ws = globalThis.sharedState.botIdToWs.get(selfId);
    }

    let nickname = e.raw?.card || e.raw?.nickname;
    if (!nickname && typeof globalThis.wsCall === 'function') {
        try {
            const info = await globalThis.wsCall('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: true }, 5000, ws);
            nickname = info?.data?.card || info?.data?.nickname;
        } catch(err) {}
    }
    if (!nickname) nickname = '未知昵称';

    await this.startVerification(groupId, userId, nickname, ws);
  },

  async handle(msg) {
    if (!msg.isGroup) return false;
    
    const groupId = msg.chatId;
    const senderQQ = String(msg.senderQQ);
    const ws = msg._ws; // 🌟 统一使用
    
    // dispatcher 强制转发时，可能用户带了自己的前缀，这里再剥一次防呆
    let cmd = (msg.pureText || "").trim();
    const dynamicPrefixes = ['/', '$', '#', '!', '。'];
    for (const p of dynamicPrefixes) {
        if (cmd.startsWith(p)) { cmd = cmd.slice(p.length).trim(); break; }
    }
    
    const msgId = msg.message_id || msg.messageId || msg.rawData?.message_id;
    const config = this.loadConfig();
    const msgs = config.messages || {};

    // ... [帮助菜单渲染逻辑完全保留你原来的，这里为了篇幅折叠] ...
    if (cmd === '入群验证帮助' || cmd === '验证帮助' || cmd === '入群申请帮助' || cmd === '申请帮助') {
        // 原样照抄你的代码即可
        // return { file: buffer } / 文本降级
    }

    // ==========================================
    // 1. 处理管理指令
    // ==========================================
    if (cmd.startsWith('开启入群验证') || cmd.startsWith('关闭入群验证') || cmd === '切换算术题' || cmd === '切换文本验证' || cmd === '切换图片验证' || cmd.startsWith('跳过验证') || cmd.startsWith('重新验证')) {
        let hasPermission = false;
        try {
            // 🌟 加上 ws
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) }, 5000, ws);
            const role = res?.data?.role;
            if (role === 'owner' || role === 'admin') hasPermission = true;
        } catch (e) {}
        
        if (!hasPermission && typeof getRole === 'function') {
            if (['master', 'owner'].includes(getRole(senderQQ))) hasPermission = true;
        }
        if (!hasPermission) return '❌ 权限不足：仅群主、管理员或主人可操作。';

        if (cmd === '开启入群验证') { this.setGroupSetting(groupId, 'enabled', 1); return '✅ 已开启本群入群验证。'; }
        if (cmd === '关闭入群验证') { this.setGroupSetting(groupId, 'enabled', 0); return '✅ 已关闭本群入群验证，新成员将直接放行。'; }
        if (cmd === '切换算术题') { this.setGroupSetting(groupId, 'verify_type', 'math'); return '✅ 验证方式已切换为【算术题】。'; }
        if (cmd === '切换文本验证') { this.setGroupSetting(groupId, 'verify_type', 'text'); return '✅ 验证方式已切换为【大小写字母+数字验证码】。'; }
        if (cmd === '切换图片验证') { this.setGroupSetting(groupId, 'verify_type', 'image'); return '✅ 验证方式已切换为【图片验证码】。'; }

        let targetQQ = null;
        if (Array.isArray(msg.message)) {
            const atItem = msg.message.find(item => item?.type === 'at');
            if (atItem && atItem.data && atItem.data.qq && atItem.data.qq !== 'all') targetQQ = String(atItem.data.qq);
        }
        if (!targetQQ) {
            const match = cmd.match(/@([^\s]+)/) || cmd.match(/(?<!\d)(\d{5,12})(?!\d)/);
            if (match) targetQQ = match[1];
        }
        if (!targetQQ) return '⚠️ 请 @ 需要操作的用户，或者附带正确的 QQ 号。';

        if (cmd.startsWith('跳过验证')) {
            const key = `${groupId}_${targetQQ}`;
            if (pendingVerifications.has(key)) {
                const data = pendingVerifications.get(key);
                clearTimeout(data.timer);
                pendingVerifications.delete(key);
                if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(targetQQ);
                return this.formatMsg(msgs.skip_success || "✅ 已强制跳过用户 {nickname}({userId}) 的验证。", { nickname: data.nickname, userId: targetQQ });
            } else {
                if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(targetQQ);
                return `⚠️ 用户 ${targetQQ} 当前不在验证状态中。`;
            }
        }

        if (cmd.startsWith('重新验证')) {
            let nickname = '未知昵称';
            try {
                const info = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(targetQQ) }, 5000, ws);
                nickname = info?.data?.card || info?.data?.nickname || nickname;
            } catch(e) {}
            await this.startVerification(groupId, targetQQ, nickname, ws);
            return this.formatMsg(msgs.reverify_success || "✅ 已重新对 {nickname}({userId}) 发起验证。", { nickname, userId: targetQQ });
        }
    }

    // ==========================================
    // 2. 处理待验证者的回复 (此时已经被强制塞入了)
    // ==========================================
    const key = `${groupId}_${senderQQ}`;
    if (!pendingVerifications.has(key)) {
        // 没在验证状态，安全清理多余的 session
        if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(String(senderQQ));
        return false;
    }

    const data = pendingVerifications.get(key);
    
    if (cmd === data.answer) {
        clearTimeout(data.timer);
        pendingVerifications.delete(key);
        if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(String(senderQQ));

        const successText = msgs.verify_success || " 验证成功！欢迎加入本群。";
        try {
            await globalThis.wsCall('send_group_msg', {
                group_id: Number(groupId),
                message: [{ type: 'at', data: { qq: String(senderQQ) } }, { type: 'text', data: { text: successText } }]
            }, 5000, ws);
        } catch (err) {}
        return true; 
    } else {
        // 撤回
        if (msgId) {
            try { await globalThis.wsCall('delete_msg', { message_id: Number(msgId) }, 3000, ws); } catch (e) {}
        }

        data.wrongCount += 1;
        
        if (data.wrongCount >= 3) {
            clearTimeout(data.timer);
            pendingVerifications.delete(key);
            if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(String(senderQQ));

            const wrongText = msgs.wrong_answer || " ⚠️ 验证失败，请重新验证！(错误次数: {wrongCount}/3)";
            try {
                await globalThis.wsCall('send_group_msg', {
                    group_id: Number(groupId),
                    message: [{ type: 'at', data: { qq: String(senderQQ) } }, { type: 'text', data: { text: this.formatMsg(wrongText, { wrongCount: data.wrongCount }) } }]
                }, 5000, ws);
            } catch(e) {}

            await new Promise(r => setTimeout(r, 1000));

            try {
                await globalThis.wsCall('set_group_kick', { group_id: Number(groupId), user_id: Number(senderQQ), reject_add_request: true }, 5000, ws);
                const kickText = msgs.max_wrong_kick || "❌ 用户 {nickname}({userId}) 连续验证失败，已自动踢出。";
                await globalThis.wsCall('send_group_msg', {
                    group_id: Number(groupId),
                    message: [{ type: 'text', data: { text: this.formatMsg(kickText, { nickname: data.nickname, userId: senderQQ }) } }]
                }, 5000, ws);
            } catch (err) {
                await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text: `⚠️ 试图踢出用户失败，请检查 Bot 是否为管理员。` } }] }, 5000, ws);
            }
            return true;
        }

        const wrongText = msgs.wrong_answer || " ⚠️ 验证失败，请重新验证！(错误次数: {wrongCount}/3)";
        return [
            { type: 'at', data: { qq: String(senderQQ) } },
            { type: 'text', data: { text: this.formatMsg(wrongText, { wrongCount: data.wrongCount }) } }
        ];
    }
  }
};