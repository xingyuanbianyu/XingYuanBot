// xy-plugins/QQ/anti-bad-words/index.js
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'bad_words.db');
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const GLOBAL_CONFIG_PATH = path.join(process.cwd(), 'xy-config/config/config.yaml');

// 初始化数据库
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS group_bad_words (
    group_id TEXT,
    word TEXT,
    match_type TEXT,
    PRIMARY KEY(group_id, word)
  )
`);

// 浏览器实例
let warnBrowser = null;
let browserLaunching = null;

// 🌟 动态获取所有配置的前缀
function getDynamicPrefixes() {
    let prefixes = ['/', '$', '#']; // 极简兜底
    try {
        if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
            const authConfig = yaml.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) || {};
            if (authConfig.command_prefix && Array.isArray(authConfig.command_prefix.prefixes)) {
                prefixes = authConfig.command_prefix.prefixes;
            }
        }
    } catch (e) {}
    return prefixes;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export default {
    name: '违禁词拦截',
    
    // 匹配所有消息
    match(text) {
        if (!text || typeof text !== 'string') return false;
        return true; 
    },

    async handle(msg) {
        if (!msg.isGroup) return false;
        
        // 🌟 核心修复 1：动态剥离前缀
        let cmd = (msg.pureText || "").trim();
        const dynamicPrefixes = getDynamicPrefixes();
        for (const p of dynamicPrefixes) {
            if (cmd.startsWith(p)) {
                cmd = cmd.slice(p.length).trim();
                break;
            }
        }

        const groupId = String(msg.chatId);
        const senderQQ = String(msg.senderQQ);
        const senderName = msg.senderName || '未知';

        // 获取配置
        let config = { mute_time: 600, warn_text: '请遵守群规，文明发言！' };
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                config = { ...config, ...(yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}) };
            }
        } catch (e) {}

        // ==========================================
        // 1. 处理管理指令
        // ==========================================
        const isCmd = cmd.startsWith('添加违禁词') || cmd.startsWith('删除违禁词') || cmd.startsWith('查看违禁词');
        
        if (isCmd) {
            let hasPermission = false;
            try {
                const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
                if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
            } catch (e) {}
            if (!hasPermission && typeof getRole === 'function') {
                if (['master', 'owner', 'admin'].includes(getRole(senderQQ))) hasPermission = true;
            }
            if (!hasPermission) return '❌ 权限不足：仅群管或主人可设置违禁词。';

            if (cmd.startsWith('添加违禁词')) {
                const rest = cmd.replace('添加违禁词', '').trim();
                const match = rest.match(/^(.+?)(?:\s+(精确|模糊))?$/);
                if (!match) return '⚠️ 用法：添加违禁词 词 [精确/模糊]';

                const word = match[1].trim();
                const type = match[2] === '精确' ? 'exact' : 'fuzzy'; // 默认模糊

                db.prepare('INSERT OR REPLACE INTO group_bad_words (group_id, word, match_type) VALUES (?, ?, ?)').run(groupId, word, type);
                return `✅ 已添加违禁词：【${word}】，匹配模式：${type === 'exact' ? '精确' : '模糊'}。`;
            }

            if (cmd.startsWith('删除违禁词')) {
                const word = cmd.replace('删除违禁词', '').trim();
                if (!word) return '⚠️ 用法：删除违禁词 词';
                
                const info = db.prepare('DELETE FROM group_bad_words WHERE group_id = ? AND word = ?').run(groupId, word);
                return info.changes > 0 ? `✅ 已删除违禁词：【${word}】。` : `⚠️ 违禁词【${word}】不存在。`;
            }

            if (cmd.startsWith('查看违禁词')) {
                const rows = db.prepare('SELECT word, match_type FROM group_bad_words WHERE group_id = ?').all(groupId);
                if (rows.length === 0) return '📭 当前群没有设置任何违禁词。';
                
                let reply = `🛑 本群违禁词列表（共 ${rows.length} 个）：\n`;
                rows.forEach((r, i) => {
                    reply += `${i + 1}. ${r.word} (${r.match_type === 'exact' ? '精确' : '模糊'})\n`;
                });
                return reply.trim();
            }
            return false;
        }

        // ==========================================
        // 2. 违禁词检测（普通聊天消息）
        // ==========================================
        // 豁免管理员和主人
        let isExempt = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
            if (['owner', 'admin'].includes(res?.data?.role)) isExempt = true;
        } catch (e) {}
        if (isExempt || (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ)))) {
            return false; // 放行
        }

        const badWords = db.prepare('SELECT word, match_type FROM group_bad_words WHERE group_id = ?').all(groupId);
        if (badWords.length === 0) return false;

        let triggeredWord = null;
        
        // 🌟 核心修复 2：忽略大小写进行比对
        const lowerCmd = cmd.toLowerCase();

        for (const item of badWords) {
            const lowerWord = item.word.toLowerCase();
            if (item.match_type === 'exact') {
                if (lowerCmd === lowerWord) { triggeredWord = item.word; break; }
            } else {
                if (lowerCmd.includes(lowerWord)) { triggeredWord = item.word; break; }
            }
        }

        if (triggeredWord) {
            globalThis.print(`[违禁词] 拦截到 ${senderName}(${senderQQ}) 触发词: ${triggeredWord}`);

            if (msg.message_id) {
                try { await globalThis.wsCall('delete_msg', { message_id: Number(msg.message_id) }); } catch (e) {}
            }

            const muteTime = config.mute_time || 600;
            let muteSuccess = false;
            try {
                const res = await globalThis.wsCall('set_group_ban', { group_id: Number(groupId), user_id: Number(senderQQ), duration: muteTime });
                if (res.status === 'ok' || res.retcode === 0) muteSuccess = true;
            } catch (e) {}

            const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${senderQQ}&s=640`;
            const warnText = escapeHtml(config.warn_text);
            const muteText = muteSuccess ? `禁言 ${Math.floor(muteTime / 60)} 分钟` : '禁言失败(权限不足)';

            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; display: inline-block; }
                    .card { 
                        background: linear-gradient(145deg, #2a1515, #1a0f0f); 
                        border-radius: 20px; width: 460px; padding: 24px; 
                        border: 1px solid rgba(255, 50, 50, 0.3); 
                        box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5); position: relative; overflow: hidden;
                    }
                    .card::before {
                        content: ''; position: absolute; top: -50px; left: -50px; width: 150px; height: 150px;
                        background: #F44336; filter: blur(80px); opacity: 0.25; z-index: 0;
                    }
                    .content { position: relative; z-index: 1; display: flex; align-items: center; gap: 16px; }
                    .avatar-box { flex-shrink: 0; width: 64px; height: 64px; border-radius: 50%; border: 2px solid #F44336; box-shadow: 0 0 15px rgba(244,67,54,0.4); overflow: hidden; position: relative; }
                    .avatar-box img { width: 100%; height: 100%; object-fit: cover; }
                    .badge { position: absolute; bottom: -2px; right: -2px; background: #1e1e24; border-radius: 50%; width: 24px; height: 24px; display: flex; justify-content: center; align-items: center; font-size: 14px; border: 1px solid rgba(255,255,255,0.1); }
                    .text-box { flex: 1; display: flex; flex-direction: column; gap: 6px; }
                    .title { font-size: 18px; color: #ff5252; font-weight: bold; }
                    .desc { font-size: 14px; color: #ddd; line-height: 1.5; }
                    .highlight { color: #ff5252; font-weight: bold; }
                    .footer { font-size: 12px; color: #777; margin-top: 12px; text-align: right; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="content">
                        <div class="avatar-box">
                            <img src="${avatarUrl}">
                            <div class="badge">🚫</div>
                        </div>
                        <div class="text-box">
                            <div class="title">⚠️ 触发违禁词警告</div>
                            <div class="desc">用户 <span class="highlight">${escapeHtml(senderName)}</span> 发送了违规内容。<br>触发词：<span class="highlight">${escapeHtml(triggeredWord)}</span><br>处罚：<span class="highlight">${muteText}</span></div>
                            <div class="desc" style="font-size:12px; margin-top:4px;">${warnText}</div>
                        </div>
                    </div>
                    <div class="footer">XingYuanBot 自动风控</div>
                </div>
            </body>
            </html>
            `;

            let imageBuffer = null;
            try {
                let chromium = null;
                try { chromium = (await import('playwright')).chromium; } catch (e) {}
                if (chromium) {
                    if (!warnBrowser || !warnBrowser.isConnected()) {
                        if (!browserLaunching) {
                            browserLaunching = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] }).then(b => {
                                warnBrowser = b; browserLaunching = null; return b;
                            });
                        }
                        await browserLaunching;
                    }
                    const ctx = await warnBrowser.newContext({ deviceScaleFactor: 2, viewport: { width: 600, height: 800 } });
                    const page = await ctx.newPage();
                    await page.setContent(html, { waitUntil: 'networkidle' });
                    const el = await page.$('.card');
                    imageBuffer = await el.screenshot({ type: 'png', omitBackground: true });
                    await ctx.close();
                }
            } catch (err) {
                console.error('❌ [违禁词] 渲染图片失败:', err.message);
            }

            if (imageBuffer) {
                globalThis.bot.send({ chatId: Number(groupId), isGroup: true, file: imageBuffer });
            } else {
                globalThis.bot.send({ chatId: Number(groupId), isGroup: true, content: `⚠️ 警告：${senderName} 触发违禁词【${triggeredWord}】，已被${muteText}！` });
            }

            return true; 
        }

        return false; 
    }
};