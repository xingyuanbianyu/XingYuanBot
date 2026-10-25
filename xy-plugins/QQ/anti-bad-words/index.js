import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'bad_words.db');
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
// 🌟 修复：修正全局配置路径
const GLOBAL_CONFIG_PATH = path.resolve(__dirname, '../../../xy-config/config.yaml');

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

// 🌟 缓存违禁词，减少数据库压力
const badWordsCache = new Map(); // groupId -> [{word, match_type}]
function refreshBadWordsCache(groupId) {
    const rows = db.prepare('SELECT word, match_type FROM group_bad_words WHERE group_id = ?').all(groupId);
    badWordsCache.set(groupId, rows);
    return rows;
}

function getDynamicPrefixes() {
    let prefixes = ['/', '$', '#'];
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
        return !!text; 
    },

    async handle(msg) {
        if (!msg.isGroup) return false;
        
        let cmd = (msg.pureText || "").trim();
        const dynamicPrefixes = getDynamicPrefixes();
        let strippedCmd = cmd;
        for (const p of dynamicPrefixes) {
            if (strippedCmd.startsWith(p)) {
                strippedCmd = strippedCmd.slice(p.length).trim();
                break;
            }
        }

        const groupId = String(msg.chatId);
        const senderQQ = String(msg.senderQQ);
        const senderName = msg.senderName || '未知';
        const ws = msg._ws;

        // ==========================================
        // 1. 快速处理管理指令
        // ==========================================
        const isCmd = strippedCmd.startsWith('添加违禁词') || strippedCmd.startsWith('删除违禁词') || strippedCmd.startsWith('查看违禁词');
        
        if (isCmd) {
            let hasPermission = false;
            
            // 🌟 优化 1：优先查本地缓存
            const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
            const member = cachedMembers.find(m => String(m.user_id) === senderQQ);
            
            if (member && ['owner', 'admin'].includes(member.role)) {
                hasPermission = true;
            } else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ))) {
                hasPermission = true;
            } else {
                // 缓存没命中，才请求 API
                try {
                    const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) }, 3000, ws);
                    if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
                } catch (e) {}
            }

            if (!hasPermission) return '❌ 权限不足：仅群管或主人可设置违禁词。';

            if (strippedCmd.startsWith('添加违禁词')) {
                const rest = strippedCmd.replace('添加违禁词', '').trim();
                const match = rest.match(/^(.+?)(?:\s+(精确|模糊))?$/);
                if (!match) return '⚠️ 用法：添加违禁词 词 [精确/模糊]';

                const word = match[1].trim();
                const type = match[2] === '精确' ? 'exact' : 'fuzzy';

                db.prepare('INSERT OR REPLACE INTO group_bad_words (group_id, word, match_type) VALUES (?, ?, ?)').run(groupId, word, type);
                refreshBadWordsCache(groupId); // 刷新缓存
                return `✅ 已添加违禁词：【${word}】，匹配模式：${type === 'exact' ? '精确' : '模糊'}。`;
            }

            if (strippedCmd.startsWith('删除违禁词')) {
                const word = strippedCmd.replace('删除违禁词', '').trim();
                if (!word) return '⚠️ 用法：删除违禁词 词';
                
                const info = db.prepare('DELETE FROM group_bad_words WHERE group_id = ? AND word = ?').run(groupId, word);
                if (info.changes > 0) {
                    refreshBadWordsCache(groupId); // 刷新缓存
                    return `✅ 已删除违禁词：【${word}】。`;
                }
                return `⚠️ 违禁词【${word}】不存在。`;
            }

            if (strippedCmd.startsWith('查看违禁词')) {
                const rows = refreshBadWordsCache(groupId);
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
        // 2. 违禁词检测
        // ==========================================
        // 🌟 优化 2：先查违禁词列表，如果列表为空直接放行，别再发权限请求了！
        let badWords = badWordsCache.get(groupId);
        if (!badWords) {
            badWords = refreshBadWordsCache(groupId);
        }
        if (badWords.length === 0) return false;

        let triggeredWord = null;
        const lowerCmd = cmd.toLowerCase();

        for (const item of badWords) {
            const lowerWord = item.word.toLowerCase();
            if (item.match_type === 'exact') {
                if (lowerCmd === lowerWord) { triggeredWord = item.word; break; }
            } else {
                if (lowerCmd.includes(lowerWord)) { triggeredWord = item.word; break; }
            }
        }

        // 🌟 优化 3：如果没有触发违禁词，直接放行，千万别去查权限！
        if (!triggeredWord) return false;

        // ==========================================
        // 3. 触发违禁词后的权限豁免检查
        // ==========================================
        let isExempt = false;
        const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
        const member = cachedMembers.find(m => String(m.user_id) === senderQQ);
        
        if (member && ['owner', 'admin'].includes(member.role)) {
            isExempt = true;
        } else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ))) {
            isExempt = true;
        }
        
        if (isExempt) return false;

        // ==========================================
        // 4. 执行处罚（撤回 + 禁言）
        // ==========================================
        globalThis.print(`[违禁词] 拦截到 ${senderName}(${senderQQ}) 触发词: ${triggeredWord}`);

        if (msg.message_id) {
            try { await globalThis.wsCall('delete_msg', { message_id: Number(msg.message_id) }, 3000, ws); } catch (e) {}
        }

        let config = { mute_time: 600, warn_text: '请遵守群规，文明发言！' };
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                config = { ...config, ...(yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}) };
            }
        } catch (e) {}

        const muteTime = config.mute_time || 600;
        let muteSuccess = false;
        try {
            const res = await globalThis.wsCall('set_group_ban', { group_id: Number(groupId), user_id: Number(senderQQ), duration: muteTime }, 3000, ws);
            if (res.status === 'ok' || res.retcode === 0) muteSuccess = true;
        } catch (e) {}

        const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${senderQQ}&s=640`;
        const warnText = escapeHtml(config.warn_text);
        const muteText = muteSuccess ? `禁言 ${Math.floor(muteTime / 60)} 分钟` : '禁言失败(权限不足)';

        // ... [HTML 渲染部分完全保留你原来的，这里省略以节省篇幅] ...
        const html = `...`; // 请把原来的 HTML 粘贴回来

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
                try { // 🌟 修复：确保 Context 必定关闭
                    const page = await ctx.newPage();
                    await page.setContent(html, { waitUntil: 'networkidle' });
                    const el = await page.$('.card');
                    imageBuffer = await el.screenshot({ type: 'png', omitBackground: true });
                } finally {
                    await ctx.close().catch(()=>{});
                }
            }
        } catch (err) {
            console.error('❌ [违禁词] 渲染图片失败:', err.message);
        }

        if (imageBuffer) {
            globalThis.bot.send({ chatId: Number(groupId), isGroup: true, file: imageBuffer, botId: msg.botId, _ws: ws });
        } else {
            globalThis.bot.send({ chatId: Number(groupId), isGroup: true, content: `⚠️ 警告：${senderName} 触发违禁词【${triggeredWord}】，已被${muteText}！`, botId: msg.botId, _ws: ws });
        }

        return true; 
    }
};