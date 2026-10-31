import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'bad_words.db');
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
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
let isRendering = false; // 🌟 核心修复 1：渲染互斥锁，防止高并发时内存爆炸

// 缓存违禁词
const badWordsCache = new Map(); 
function refreshBadWordsCache(groupId) {
    const rows = db.prepare('SELECT word, match_type FROM group_bad_words WHERE group_id = ?').all(groupId);
    badWordsCache.set(groupId, rows);
    return rows;
}

// 🌟 核心修复 2：群管权限本地缓存，防止 API 被刷爆
const permCache = new Map(); 
function getCachedPermission(groupId, senderQQ, msg) {
    const key = `${groupId}_${senderQQ}`;
    const cached = permCache.get(key);
    if (cached && cached.expire > Date.now()) return cached.isAdmin;
    return null; // 没缓存，需要去查
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
    
    match(text) {
        return !!text; 
    },

    async handle(msg) {
        if (!msg.isGroup) return false;
        
        // 锁 1：防止自己杀自己
        if (msg.isSelf) return false;

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
        const ws = msg._ws || globalThis.activeWs;

        // ==========================================
        // 1. 快速处理管理指令
        // ==========================================
        const isCmd = strippedCmd.startsWith('添加违禁词') || strippedCmd.startsWith('删除违禁词') || strippedCmd.startsWith('查看违禁词');
        
        if (isCmd) {
            let hasPermission = false;
            
            // 先查本地缓存
            const cachedPerm = getCachedPermission(groupId, senderQQ, msg);
            if (cachedPerm === true) {
                hasPermission = true;
            } else {
                const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
                const member = cachedMembers.find(m => String(m.user_id) === senderQQ);
                
                if (member && ['owner', 'admin'].includes(member.role)) {
                    hasPermission = true;
                } else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ, msg.botId))) {
                    hasPermission = true;
                } else {
                    try {
                        const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) }, 3000, ws);
                        if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
                        // 写入缓存 5 分钟
                        permCache.set(`${groupId}_${senderQQ}`, { isAdmin: hasPermission, expire: Date.now() + 300000 });
                    } catch (e) {}
                }
            }

            if (!hasPermission) return '❌ 权限不足：仅群管或主人可设置违禁词。';

            if (strippedCmd.startsWith('添加违禁词')) {
                const rest = strippedCmd.replace('添加违禁词', '').trim();
                const match = rest.match(/^(.+?)(?:\s+(精确|模糊))?$/);
                if (!match) return '⚠️ 用法：添加违禁词 词 [精确/模糊]';

                const word = match[1].trim();
                const type = match[2] === '精确' ? 'exact' : 'fuzzy';

                db.prepare('INSERT OR REPLACE INTO group_bad_words (group_id, word, match_type) VALUES (?, ?, ?)').run(groupId, word, type);
                refreshBadWordsCache(groupId); 
                return `✅ 已添加违禁词：【${word}】，匹配模式：${type === 'exact' ? '精确' : '模糊'}。`;
            }

            if (strippedCmd.startsWith('删除违禁词')) {
                const word = strippedCmd.replace('删除违禁词', '').trim();
                if (!word) return '⚠️ 用法：删除违禁词 词';
                
                const info = db.prepare('DELETE FROM group_bad_words WHERE group_id = ? AND word = ?').run(groupId, word);
                if (info.changes > 0) {
                    refreshBadWordsCache(groupId); 
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
        let badWords = badWordsCache.get(groupId);
        if (badWords === undefined) { // 🌟 修复：空数组也是有效值，不能单用 !badWords
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

        if (!triggeredWord) return false;

        // ==========================================
        // 3. 触发违禁词后的权限豁免检查
        // ==========================================
        let isExempt = false;
        const cachedPerm = getCachedPermission(groupId, senderQQ, msg);
        if (cachedPerm === true) {
            isExempt = true;
        } else {
            const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
            const member = cachedMembers.find(m => String(m.user_id) === senderQQ);
            
            if (member && ['owner', 'admin'].includes(member.role)) {
                isExempt = true;
                permCache.set(`${groupId}_${senderQQ}`, { isAdmin: true, expire: Date.now() + 300000 });
            } else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ, msg.botId))) {
                isExempt = true;
                permCache.set(`${groupId}_${senderQQ}`, { isAdmin: true, expire: Date.now() + 300000 });
            }
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
        let failReason = '未知错误';

        // 尝试获取一下成员角色（用于防群主禁言报错）
        const membersList = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
        const targetMember = membersList.find(m => String(m.user_id) === senderQQ);

        if (targetMember && targetMember.role === 'owner') {
            failReason = '目标为群主，无法禁言';
        } else {
            try {
                const res = await globalThis.wsCall('set_group_ban', { 
                    group_id: Number(groupId), 
                    user_id: Number(senderQQ), 
                    duration: Number(muteTime) 
                }, 6000, ws);
                
                if (res && (res.status === 'ok' || res.retcode === 0)) {
                    muteSuccess = true;
                } else if (res === null) {
                    muteSuccess = true;
                } else {
                    failReason = res?.msg || res?.wording || res?.message || JSON.stringify(res) || '接口超时无响应';
                }
            } catch (e) {
                failReason = e.message || String(e);
            }
        }

        const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${senderQQ}&s=640`;
        const warnText = escapeHtml(config.warn_text);
        const muteText = muteSuccess ? `禁言 ${Math.floor(muteTime / 60)} 分钟` : `禁言失败(${failReason})`;

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; display: inline-block; }
                .card { background: linear-gradient(145deg, #2a1515, #1a0f0f); border-radius: 20px; width: 460px; padding: 24px; border: 1px solid rgba(255, 50, 50, 0.3); box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5); position: relative; overflow: hidden; }
                .card::before { content: ''; position: absolute; top: -50px; left: -50px; width: 150px; height: 150px; background: #F44336; filter: blur(80px); opacity: 0.25; z-index: 0; }
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

        // 🌟 核心修复 3：加入渲染锁，如果正在渲染，直接降级发纯文本，防止并发截图导致 OOM
        if (!isRendering) {
            isRendering = true;
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
                    try { 
                        const page = await ctx.newPage();
                        // 🌟 核心修复 4：把加载条件改为 domcontentloaded 并加超时，防止腾讯头像接口卡死整个渲染
                        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 5000 });
                        // 稍等一下图片加载
                        await page.waitForTimeout(300);
                        
                        const el = await page.$('.card');
                        if (el) imageBuffer = await el.screenshot({ type: 'png', omitBackground: true });
                    } finally {
                        await ctx.close().catch(()=>{});
                    }
                }
            } catch (err) {
                console.error('❌ [违禁词] 渲染图片失败:', err.message);
            } finally {
                isRendering = false; // 释放锁
            }
        } else {
            globalThis.print(`[违禁词] ⚠️ 渲染并发过高，自动降级为纯文本警告。`);
        }

        // 🌟 核心修复 5：统一使用 wsCall 发送，兼容性更好，带超时控制
        try {
            if (imageBuffer) {
                await globalThis.wsCall('send_group_msg', {
                    group_id: Number(groupId),
                    message: [{ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } }]
                }, 10000, ws);
            } else {
                await globalThis.wsCall('send_group_msg', {
                    group_id: Number(groupId),
                    message: [{ type: 'text', data: { text: `⚠️ 警告：${senderName} 触发违禁词【${triggeredWord}】，处罚：${muteText}！` } }]
                }, 5000, ws);
            }
        } catch (e) {
            globalThis.print(`[违禁词] ❌ 警告消息发送失败: ${e.message}`);
        }

        return true; 
    }
};