import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import os from 'os';
import { fileURLToPath } from 'url';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');

const pendingVerifications = new Map();
const DB_NAME = 'group_verify_data';
let verifyBrowser = null; // 用于缓存浏览器实例

// 辅助函数：格式化字节（备用）
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

if (typeof globalThis.db === 'function') {
    globalThis.db('exec', {
        dbName: DB_NAME,
        sql: `CREATE TABLE IF NOT EXISTS verify_settings (
            group_id TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            verify_type TEXT DEFAULT 'math'
        )`
    });
    try {
        globalThis.db('exec', { dbName: DB_NAME, sql: `ALTER TABLE verify_settings ADD COLUMN verify_type TEXT DEFAULT 'math'` });
    } catch(e) {}
}

export default {
  name: '入群验证',
  events: ['group.increase'],

  loadConfig() {
    try { return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) { return {}; }
  },

  getGroupSettings(groupId) {
    const defaults = { enabled: 0, verify_type: this.loadConfig().verify_type || 'math' };
    if (typeof globalThis.db !== 'function') return defaults;
    const res = globalThis.db('find', { dbName: DB_NAME, table: 'verify_settings', where: 'group_id = ?', params: [String(groupId)], all: false });
    if (res.success && res.data) {
        return { enabled: res.data.enabled, verify_type: res.data.verify_type || defaults.verify_type };
    }
    return defaults;
  },

  setGroupSetting(groupId, key, value) {
    if (typeof globalThis.db !== 'function') return false;
    const gid = String(groupId);
    const check = globalThis.db('find', { dbName: DB_NAME, table: 'verify_settings', where: 'group_id = ?', params: [gid], all: false });
    if (check.success && check.data) {
        globalThis.db('update', { dbName: DB_NAME, table: 'verify_settings', set: { [key]: value }, where: 'group_id = ?', params: [gid] });
    } else {
        globalThis.db('insert', { dbName: DB_NAME, table: 'verify_settings', data: { group_id: gid, [key]: value } });
    }
    return true;
  },

  formatMsg(template, data = {}) {
    if (!template) return '';
    let str = template;
    for (const [key, value] of Object.entries(data)) {
        str = str.replace(new RegExp(`{${key}}`, 'g'), value);
    }
    return str;
  },

  match(text) {
    if (typeof text !== 'string') return false;
    const cmd = text.trim();
    return cmd === '开启入群验证' || cmd === '关闭入群验证' || 
           cmd === '切换算术题' || cmd === '切换验证码' ||
           cmd === '入群验证帮助' || cmd === '验证帮助' || 
           cmd === '入群申请帮助' || cmd === '申请帮助' || // 🌟 新增：响应入群申请帮助
           cmd.startsWith('跳过验证') || cmd.startsWith('重新验证');
  },

  generateQuestion(verifyType, config) {
    if (verifyType === 'code') {
        const len = config.code_length || 4;
        const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let ans = '';
        for (let i = 0; i < len; i++) ans += chars.charAt(Math.floor(Math.random() * chars.length));
        return { answer: ans, question: `请发送验证码：${ans}\n(⚠️ 注意：严格区分大小写！)` };
    } else {
        const a = Math.floor(Math.random() * 20) + 1;
        const b = Math.floor(Math.random() * 20) + 1;
        return { answer: String(a + b), question: `请回答：${a} + ${b} = ?` };
    }
  },

  async startVerification(groupId, userId, nickname) {
    const config = this.loadConfig();
    const settings = this.getGroupSettings(groupId);
    const timeout = (config.timeout || 120) * 1000;
    const { answer, question } = this.generateQuestion(settings.verify_type, config);
    
    const msgs = config.messages || {};
    const questionPrompt = msgs.question_prompt || "请在 {timeout} 秒内回答下面的问题：";
    const warningText = msgs.warning || "(答题期间发送其他内容会被撤回，连续答错或超时将被踢出)";

    const welcomeMsg = [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text: `\n${this.formatMsg(questionPrompt, { timeout: config.timeout || 120 })}\n` } },
        { type: 'text', data: { text: question } },
        { type: 'text', data: { text: `\n${warningText}` } }
    ];

    try {
        await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: welcomeMsg });
    } catch (err) {}

    const key = `${groupId}_${userId}`;
    if (pendingVerifications.has(key)) clearTimeout(pendingVerifications.get(key).timer);

    if (globalThis._interactiveSessions) {
        globalThis._interactiveSessions.set(String(userId), { pluginName: '入群验证', expireAt: Date.now() + timeout });
    }

    const timer = setTimeout(async () => {
        try {
            await globalThis.wsCall('set_group_kick', { group_id: Number(groupId), user_id: Number(userId), reject_add_request: true });
            
            const kickText = msgs.timeout_kick || "⏰ 用户 {nickname}({userId}) 未在规定时间内完成验证，已自动踢出。";
            const finalKickMsg = this.formatMsg(kickText, { nickname, userId });

            await globalThis.wsCall('send_group_msg', {
                group_id: Number(groupId),
                message: [{ type: 'text', data: { text: finalKickMsg } }]
            });
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
    if (userId === Number(globalThis.botInfo?.qq)) return;
    
    const settings = this.getGroupSettings(groupId);
    if (settings.enabled !== 1) return;

    let nickname = e.raw?.card || e.raw?.nickname;
    if (!nickname && typeof globalThis.wsCall === 'function') {
        try {
            const info = await globalThis.wsCall('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: true });
            nickname = info?.data?.card || info?.data?.nickname;
        } catch(err) {}
    }
    if (!nickname) nickname = '未知昵称';

    await this.startVerification(groupId, userId, nickname);
  },

  async handle(msg) {
    if (!msg.isGroup) return false;
    
    const groupId = msg.chatId;
    const senderQQ = msg.senderQQ;
    const cmd = (msg.pureText || "").trim();
    const msgId = msg.message_id || msg.messageId;
    const config = this.loadConfig();
    const msgs = config.messages || {};

    // ==========================================
    // 0. 终极帮助菜单处理（合并前置审批与后置验证）
    // ==========================================
    if (cmd === '入群验证帮助' || cmd === '验证帮助' || cmd === '入群申请帮助' || cmd === '申请帮助') {
        const helpHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; display: inline-block; }
                .card { background: linear-gradient(145deg, #1e1e24, #2b2b36); border-radius: 16px; width: 480px; padding: 24px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 15px 35px rgba(0, 0, 0, 0.4); }
                .header { display: flex; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
                .header h2 { margin: 0; font-size: 20px; color: #fff; display: flex; align-items: center; gap: 10px; font-weight: 600; }
                .header .dot { width: 10px; height: 10px; background: #4CAF50; border-radius: 50%; box-shadow: 0 0 10px #4CAF50; }
                .section { margin-bottom: 20px; }
                .section:last-child { margin-bottom: 0; }
                .section-title { font-size: 13px; color: #888; margin-bottom: 12px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px; }
                .section-title::before { content: ''; display: inline-block; width: 4px; height: 14px; background: #4CAF50; border-radius: 2px; }
                .section-title.blue::before { background: #2196F3; }
                .item { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 8px; margin-bottom: 8px; background: rgba(255, 255, 255, 0.02); }
                .cmd { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; color: #81C784; background: rgba(76, 175, 80, 0.15); padding: 4px 10px; border-radius: 6px; font-weight: 600; white-space: nowrap; }
                .cmd.blue { color: #64B5F6; background: rgba(33, 150, 243, 0.15); }
                .desc { font-size: 12px; color: #bbb; text-align: right; margin-left: 10px; }
                .footer { margin-top: 24px; padding-top: 16px; border-top: 1px dashed rgba(255, 255, 255, 0.1); font-size: 12px; color: #888; text-align: center; line-height: 1.6; }
                .footer .warn { color: #FF9800; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="header">
                    <h2><div class="dot"></div> 入群管理控制台</h2>
                </div>

                <!-- 模块一：后置验证 -->
                <div class="section">
                    <div class="section-title">后置验证 (防机器人)</div>
                    <div class="item"><span class="cmd">开启入群验证</span><span class="desc">开启新成员验证拦截</span></div>
                    <div class="item"><span class="cmd">关闭入群验证</span><span class="desc">关闭验证，直接放行</span></div>
                    <div class="item"><span class="cmd">切换算术题</span><span class="desc">验证方式改为算术题</span></div>
                    <div class="item"><span class="cmd">切换验证码</span><span class="desc">验证方式改为大小写混合</span></div>
                    <div class="item"><span class="cmd">跳过验证 @某人</span><span class="desc">强制让指定用户通过</span></div>
                    <div class="item"><span class="cmd">重新验证 @某人</span><span class="desc">对指定用户重发验证</span></div>
                </div>
                
                <!-- 模块二：前置审批 -->
                <div class="section">
                    <div class="section-title blue">前置审批 (暗号/人工)</div>
                    <div class="item"><span class="cmd blue">开启入群申请</span><span class="desc">开启拦截，通知管理员</span></div>
                    <div class="item"><span class="cmd blue">关闭入群申请</span><span class="desc">关闭拦截，协议端处理</span></div>
                    <div class="item"><span class="cmd blue">设置入群答案 123</span><span class="desc">设置自动审批的暗号</span></div>
                    <div class="item"><span class="cmd blue">开启自动处理</span><span class="desc">暗号匹配则自动同意</span></div>
                    <div class="item"><span class="cmd blue">引用回复 同意 / 拒绝</span><span class="desc">管理员人工审批</span></div>
                </div>

                <div class="footer">
                    新成员入群将自动弹出题目，需严格按<span class="warn">大小写</span>发送答案。<br>
                    连续错 3 次或超时将被系统自动踢出。
                </div>
            </div>
        </body>
        </html>
        `;

        try {
            let chromium = null;
            try { chromium = (await import('playwright')).chromium; } catch (e) {
                try { chromium = (await import('puppeteer')).default || (await import('puppeteer')); } catch (e2) {}
            }

            if (!chromium) throw new Error("未安装浏览器渲染内核");

            if (!verifyBrowser || !verifyBrowser.isConnected()) {
                verifyBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
            }
            const context = await verifyBrowser.newContext({
                deviceScaleFactor: 2,
                viewport: { width: 520, height: 900 } 
            });
            const page = await context.newPage();
            await page.setContent(helpHtml, { waitUntil: 'networkidle' });
            
            const cardElement = await page.$('.card');
            const buffer = await cardElement.screenshot({ type: 'png', omitBackground: true });
            
            await context.close(); 
            
            return { file: buffer };
        } catch (e) {
            console.error('帮助菜单图片渲染失败，降级为文本:', e.message);
            return [
                { type: 'text', data: { text: `📜 【入群管理控制台】\n\n【后置验证】\n🔹 开启/关闭入群验证\n🔹 切换算术题 / 切换验证码\n🔹 跳过验证 @某人\n🔹 重新验证 @某人\n\n【前置审批】\n🔹 开启/关闭入群申请\n🔹 设置入群答案 [答案]\n🔹 开启/关闭自动处理\n🔹 引用消息回复“同意”或“拒绝”\n\n【说明】\n前置暗号匹配忽略大小写，后置验证码严格区分大小写。` } }
            ];
        }
    }

    // ==========================================
    // 1. 处理管理指令
    // ==========================================
    if (cmd.startsWith('开启入群验证') || cmd.startsWith('关闭入群验证') || cmd === '切换算术题' || cmd === '切换验证码' || cmd.startsWith('跳过验证') || cmd.startsWith('重新验证')) {
        
        let hasPermission = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
            const role = res?.data?.role;
            if (role === 'owner' || role === 'admin') hasPermission = true;
        } catch (e) {}
        
        if (!hasPermission && typeof getRole === 'function') {
            const globalRole = getRole(senderQQ);
            if (['master', 'owner'].includes(globalRole)) {
                hasPermission = true;
            }
        }

        if (!hasPermission) return '❌ 权限不足：仅群主、管理员或主人可操作。';

        if (cmd === '开启入群验证') {
            this.setGroupSetting(groupId, 'enabled', 1);
            return '✅ 已开启本群入群验证。';
        }
        if (cmd === '关闭入群验证') {
            this.setGroupSetting(groupId, 'enabled', 0);
            return '✅ 已关闭本群入群验证，新成员将直接放行。';
        }
        if (cmd === '切换算术题') {
            this.setGroupSetting(groupId, 'verify_type', 'math');
            return '✅ 验证方式已切换为【算术题】。';
        }
        if (cmd === '切换验证码') {
            this.setGroupSetting(groupId, 'verify_type', 'code');
            return '✅ 验证方式已切换为【大小写字母+数字验证码】。';
        }

        let targetQQ = null;
        if (Array.isArray(msg.message)) {
            const atItem = msg.message.find(item => item?.type === 'at');
            if (atItem && atItem.data && atItem.data.qq) targetQQ = String(atItem.data.qq);
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

                const skipText = msgs.skip_success || "✅ 已强制跳过用户 {nickname}({userId}) 的验证。";
                return this.formatMsg(skipText, { nickname: data.nickname, userId: targetQQ });
            } else {
                if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(targetQQ);
                let tempName = targetQQ;
                try {
                    const info = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(targetQQ) });
                    tempName = info?.data?.card || info?.data?.nickname || targetQQ;
                } catch(e) {}
                return `⚠️ 用户 ${tempName}(${targetQQ}) 当前不在验证状态中。`;
            }
        }

        if (cmd.startsWith('重新验证')) {
            let nickname = '未知昵称';
            try {
                const info = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(targetQQ) });
                nickname = info?.data?.card || info?.data?.nickname || nickname;
            } catch(e) {}
            
            await this.startVerification(groupId, targetQQ, nickname);
            
            const reverifyText = msgs.reverify_success || "✅ 已重新对 {nickname}({userId}) 发起验证。";
            return this.formatMsg(reverifyText, { nickname, userId: targetQQ });
        }
    }

    // ==========================================
    // 2. 处理待验证者的回复
    // ==========================================
    const key = `${groupId}_${senderQQ}`;
    if (!pendingVerifications.has(key)) {
        if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(String(senderQQ));
        return false;
    }

    const data = pendingVerifications.get(key);
    
    // 绝对区分大小写
    if (cmd === data.answer) {
        clearTimeout(data.timer);
        pendingVerifications.delete(key);
        if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(String(senderQQ));

        const successText = msgs.verify_success || " 验证成功！欢迎加入本群。";

        try {
            await globalThis.wsCall('send_group_msg', {
                group_id: Number(groupId),
                message: [
                    { type: 'at', data: { qq: String(senderQQ) } },
                    { type: 'text', data: { text: successText } }
                ]
            });
        } catch (err) {}
        return true; 
    } else {
        if (msgId) {
            try { await globalThis.wsCall('delete_msg', { message_id: Number(msgId) }); } catch (e) {}
        }

        data.wrongCount += 1;
        
        if (data.wrongCount >= 3) {
            clearTimeout(data.timer);
            pendingVerifications.delete(key);
            if (globalThis._interactiveSessions) globalThis._interactiveSessions.delete(String(senderQQ));

            try {
                await globalThis.wsCall('set_group_kick', { group_id: Number(groupId), user_id: Number(senderQQ), reject_add_request: true });
                
                const kickText = msgs.max_wrong_kick || "❌ 用户 {nickname}({userId}) 连续验证失败，已自动踢出。";
                const finalKickMsg = this.formatMsg(kickText, { nickname: data.nickname, userId: senderQQ });

                await globalThis.wsCall('send_group_msg', {
                    group_id: Number(groupId),
                    message: [{ type: 'text', data: { text: finalKickMsg } }]
                });
            } catch (err) {}
            return true;
        }

        const wrongText = msgs.wrong_answer || " ⚠️ 验证码错误（注意大小写），请重新输入！(警告 {wrongCount}/3)";
        const finalWrongMsg = this.formatMsg(wrongText, { wrongCount: data.wrongCount });

        return [
            { type: 'at', data: { qq: String(senderQQ) } },
            { type: 'text', data: { text: finalWrongMsg } }
        ];
    }
  }
};