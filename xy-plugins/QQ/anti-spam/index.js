import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'anti_spam.db');
const GLOBAL_CONFIG_PATH = path.resolve(__dirname, '../../../xy-config/config/config.yaml');

// 初始化数据库
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS group_spam_settings (
    group_id TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    limit_count INTEGER DEFAULT 5,
    time_window INTEGER DEFAULT 10,
    mute_duration INTEGER DEFAULT 180
  )
`);

// 🌟 性能核心 1：缓存群设置
const spamSettingsCache = new Map(); 
function getSettings(groupId) {
    if (spamSettingsCache.has(groupId)) return spamSettingsCache.get(groupId);
    const row = db.prepare('SELECT * FROM group_spam_settings WHERE group_id = ?').get(groupId);
    spamSettingsCache.set(groupId, row);
    return row;
}

// 🌟 优化 1：群管权限缓存，减少 API 调用频率
const permCache = new Map();

let spamBrowser = null;
let browserLaunching = null;
let isRendering = false; // 🌟 核心修复：渲染并发锁，防内存爆炸

// 🌟 核心改造 1：刷屏连击追踪器
const groupTrackerMap = new Map(); // groupId -> { lastSenderQQ, timestamps }
// 🌟 核心改造 2：阶梯违规记录器 (记录谁犯了几次)
const userViolationMap = new Map(); // userQQ -> { count, lastViolationTime }

// 🌟 性能核心 3：定时清理僵尸数据，防止内存泄漏
setInterval(() => {
    const now = Date.now();
    for (const [groupId, tracker] of groupTrackerMap.entries()) {
        if (tracker.timestamps.length === 0 || now - tracker.timestamps[tracker.timestamps.length - 1] > 10 * 60 * 1000) {
            groupTrackerMap.delete(groupId);
        }
    }
    for (const [qq, v] of userViolationMap.entries()) {
        // 如果超过 15 分钟没违规，重置次数
        if (now - v.lastViolationTime > 15 * 60 * 1000) {
            userViolationMap.delete(qq);
        }
    }
}, 60 * 1000);

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
    // 🌟 优化：前缀按长度倒序排列，防止多字符前缀被截断
    return prefixes.sort((a, b) => b.length - a.length);
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// 统一 API 成功判定
function isApiSuccess(res) {
    if (res === null || res === undefined) return true; 
    if (typeof res === 'object') {
        if (res.status === 'ok' || res.retcode === 0 || res.retcode === 1) return true;
    }
    return false;
}

export default {
    name: '防刷屏拦截',
    
    match(text) {
        return true; 
    },

    async handle(msg) {
        if (!msg.isGroup) return false;
        
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
        const ws = msg._ws || globalThis.activeWs;

        // ==========================================
        // 1. 管理指令解析
        // ==========================================
        const isCmd = cmd.startsWith('开启防刷屏') || cmd.startsWith('关闭防刷屏') || cmd.startsWith('查看防刷屏');

        if (isCmd) {
            let hasPermission = false;
            const cacheKey = `${groupId}_${senderQQ}`;
            
            // 查缓存
            if (permCache.has(cacheKey) && permCache.get(cacheKey).expire > Date.now()) {
                hasPermission = permCache.get(cacheKey).isAdmin;
            } else {
                const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
                const member = cachedMembers.find(m => String(m.user_id) === senderQQ);
                if (member && ['owner', 'admin'].includes(member.role)) hasPermission = true;
                else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ, msg.botId))) hasPermission = true;
                else {
                    try {
                        const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) }, 3000, ws);
                        const role = res?.data?.role || res?.role;
                        if (['owner', 'admin'].includes(role)) hasPermission = true;
                    } catch (e) {}
                }
                // 写入缓存 5 分钟
                permCache.set(cacheKey, { isAdmin: hasPermission, expire: Date.now() + 300000 });
            }

            if (!hasPermission) return '❌ 权限不足：仅群管或主人可配置防刷屏。';

            if (cmd.startsWith('开启防刷屏')) {
                const args = cmd.replace('开启防刷屏', '').trim().split(/\s+/);
                let limitCount = args[0] ? (parseInt(args[0]) || 5) : 5;
                let timeWindow = args[1] ? (parseInt(args[1]) || 10) : 10;
                let muteDuration = args[2] !== undefined ? (parseInt(args[2]) || 0) : 180;

                if (limitCount < 2 || timeWindow < 3) {
                    return '⚠️ 为了防误伤，限制条数不能少于 2 条，时间窗口不能少于 3 秒。';
                }

                db.prepare('INSERT OR REPLACE INTO group_spam_settings (group_id, enabled, limit_count, time_window, mute_duration) VALUES (?, ?, ?, ?, ?)')
                  .run(groupId, 1, limitCount, timeWindow, muteDuration);
                
                spamSettingsCache.delete(groupId);

                return `✅ 已开启【阶梯防刷屏】！\n⏱ 规则：${timeWindow} 秒内连续发 ${limitCount} 条消息\n🛡️ 处罚：\n  1️⃣ 第一次：撤回+警告\n  2️⃣ 第二次：撤回+禁言 ${muteDuration} 秒\n  3️⃣ 第三次：直接踢出本群`;
            }

            if (cmd.startsWith('关闭防刷屏')) {
                db.prepare('UPDATE group_spam_settings SET enabled = 0 WHERE group_id = ?').run(groupId);
                spamSettingsCache.delete(groupId);
                return '✅ 已关闭本群防刷屏监控。';
            }

            if (cmd.startsWith('查看防刷屏')) {
                const row = getSettings(groupId);
                if (!row || row.enabled === 0) {
                    return '⚙️ 本群防刷屏监控当前【未开启】。\n发送：开启防刷屏 [条数] [秒数] [禁言秒数]';
                }
                return `⚙️ 本群防刷屏配置：\n⏱ 规则：${row.time_window} 秒内连续发 ${row.limit_count} 条消息\n🛡️ 处罚：阶梯式（警告 -> 禁言 ${row.mute_duration}秒 -> 踢出）`;
            }
            return false;
        }

        // ==========================================
        // 2. 刷屏检测逻辑
        // ==========================================
        const settings = getSettings(groupId);
        if (!settings || settings.enabled === 0) return false;

        const { limit_count, time_window, mute_duration } = settings;
        const now = Date.now();

        let tracker = groupTrackerMap.get(groupId);
        if (!tracker || tracker.lastSenderQQ !== senderQQ) {
            tracker = { lastSenderQQ: senderQQ, timestamps: [now] };
            groupTrackerMap.set(groupId, tracker);
        } else {
            tracker.timestamps = tracker.timestamps.filter(t => now - t < time_window * 1000);
            tracker.timestamps.push(now);
        }

        // 还没达到触发阈值，放行
        if (tracker.timestamps.length < limit_count) {
            return false;
        }

        // ==========================================
        // 3. 触发阈值，进行权限豁免判定
        // ==========================================
        let isExempt = false;
        const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
        const member = cachedMembers.find(m => String(m.user_id) === senderQQ);
        
        if (member && ['owner', 'admin'].includes(member.role)) isExempt = true;
        else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ, msg.botId))) isExempt = true;

        if (isExempt) return false; 

        // ==========================================
        // 4. 执行阶梯处罚
        // ==========================================
        groupTrackerMap.delete(groupId); // 重置连击
        
        // 获取当前用户的违规次数
        let vRecord = userViolationMap.get(senderQQ) || { count: 0, lastViolationTime: now };
        vRecord.count += 1;
        vRecord.lastViolationTime = now;
        userViolationMap.set(senderQQ, vRecord);

        const currentCount = vRecord.count;
        globalThis.print(`[防刷屏] 🚨 拦截到 ${senderName}(${senderQQ})！本次为第 ${currentCount} 次违规。`);

        // 撤回当前刷屏消息
        if (msg.message_id) {
            try { await globalThis.wsCall('delete_msg', { message_id: Number(msg.message_id) }, 3000, ws); } catch (e) {}
        }

        let penaltyTitle = '';
        let penaltyText = '';
        let actionSuccess = false;
        let icon = '⚠️';
        let themeColor = '#FF9800';

        if (currentCount === 1) {
            // 第一次：警告
            penaltyTitle = '触发防刷屏警告';
            penaltyText = '仅撤回并警告（再犯将禁言）';
        } 
        else if (currentCount === 2) {
            // 第二次：禁言
            penaltyTitle = '触发防刷屏严惩';
            icon = '🔇';
            themeColor = '#F44336';
            penaltyText = `禁言 ${mute_duration} 秒`;
            
            if (mute_duration > 0) {
                try {
                    const res = await globalThis.wsCall('set_group_ban', { group_id: Number(groupId), user_id: Number(senderQQ), duration: mute_duration }, 3000, ws);
                    if (isApiSuccess(res)) actionSuccess = true;
                } catch (e) {}
            }
            if (!actionSuccess) penaltyText = '禁言失败(无权限)';
        } 
        else {
            // 第三次：踢出
            penaltyTitle = '触发防刷屏踢出';
            icon = '🥾';
            themeColor = '#9C27B0';
            penaltyText = '直接踢出本群';
            
            try {
                const res = await globalThis.wsCall('set_group_kick', { group_id: Number(groupId), user_id: Number(senderQQ), reject_add_request: false }, 3000, ws);
                if (isApiSuccess(res)) actionSuccess = true;
            } catch (e) {}
            if (!actionSuccess) penaltyText = '踢出失败(无权限)';
            
            // 踢出后删除违规记录
            userViolationMap.delete(senderQQ);
        }

        // ==========================================
        // 5. 渲染警告卡片
        // ==========================================
        const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${senderQQ}&s=640`;
        const warnHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; display: inline-block; }
                .card { background: linear-gradient(145deg, #2a2525, #1a1515); border-radius: 20px; width: 460px; padding: 24px; border: 1px solid ${themeColor}66; box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5); position: relative; overflow: hidden; }
                .card::before { content: ''; position: absolute; top: -50px; left: -50px; width: 150px; height: 150px; background: ${themeColor}; filter: blur(80px); opacity: 0.25; z-index: 0; }
                .content { position: relative; z-index: 1; display: flex; align-items: center; gap: 16px; }
                .avatar-box { flex-shrink: 0; width: 64px; height: 64px; border-radius: 50%; border: 2px solid ${themeColor}; box-shadow: 0 0 15px ${themeColor}66; overflow: hidden; position: relative; }
                .avatar-box img { width: 100%; height: 100%; object-fit: cover; }
                .badge { position: absolute; bottom: -2px; right: -2px; background: #1e1e24; border-radius: 50%; width: 24px; height: 24px; display: flex; justify-content: center; align-items: center; font-size: 14px; border: 1px solid rgba(255,255,255,0.1); }
                .text-box { flex: 1; display: flex; flex-direction: column; gap: 6px; }
                .title { font-size: 18px; color: ${themeColor}; font-weight: bold; }
                .desc { font-size: 14px; color: #ddd; line-height: 1.5; }
                .highlight { color: ${themeColor}; font-weight: bold; }
                .footer { font-size: 12px; color: #666; text-align: right; margin-top: 12px; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="content">
                    <div class="avatar-box">
                        <img src="${avatarUrl}" onerror="this.style.display='none'">
                        <div class="badge">${icon}</div>
                    </div>
                    <div class="text-box">
                        <div class="title">${penaltyTitle}</div>
                        <div class="desc">用户 <span class="highlight">${escapeHtml(senderName)}</span> 发言过快。<br>违规次数：<span class="highlight">第 ${currentCount} 次</span><br>处罚：<span class="highlight">${penaltyText}</span></div>
                        <div class="desc" style="font-size:12px; margin-top:4px;">请遵守群规，文明发言！(15分钟内多次违规将升级处罚)</div>
                    </div>
                </div>
                <div class="footer">XingYuanBot 自动风控</div>
            </div>
        </body>
        </html>
        `;

        let imageBuffer = null;

        // 🌟 核心修复 2：加入渲染锁
        if (!isRendering) {
            isRendering = true;
            try {
                let chromium = null;
                try { chromium = (await import('playwright')).chromium; } catch (e) {}
                if (chromium) {
                    if (!spamBrowser || !spamBrowser.isConnected()) {
                        if (!browserLaunching) {
                            browserLaunching = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] }).then(b => {
                                spamBrowser = b; browserLaunching = null; return b;
                            });
                        }
                        await browserLaunching;
                    }
                    const ctx = await spamBrowser.newContext({ deviceScaleFactor: 2, viewport: { width: 600, height: 800 } });
                    try { 
                        const page = await ctx.newPage();
                        // 🌟 核心修复 3：防止头像接口卡死渲染
                        await page.setContent(warnHtml, { waitUntil: 'domcontentloaded', timeout: 5000 });
                        await page.waitForTimeout(300);
                        
                        const el = await page.$('.card');
                        if (el) imageBuffer = await el.screenshot({ type: 'png', omitBackground: true });
                    } finally {
                        await ctx.close().catch(()=>{});
                    }
                }
            } catch (err) {
                console.error('❌ [防刷屏] 渲染图片失败:', err.message);
            } finally {
                isRendering = false;
            }
        } else {
            globalThis.print(`[防刷屏] ⚠️ 渲染并发过高，自动降级为纯文本。`);
        }

        // ==========================================
        // 6. 发送通知 (统一使用 wsCall)
        // ==========================================
        try {
            if (imageBuffer) {
                await globalThis.wsCall('send_group_msg', {
                    group_id: Number(groupId),
                    message: [{ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } }]
                }, 10000, ws);
            } else {
                await globalThis.wsCall('send_group_msg', {
                    group_id: Number(groupId),
                    message: [{ type: 'text', data: { text: `⚠️ 警告：${senderName} 连续发言过快（第${currentCount}次违规），处罚：${penaltyText}！` } }]
                }, 5000, ws);
            }
        } catch (e) {
            globalThis.print(`[防刷屏] ❌ 警告消息发送失败: ${e.message}`);
        }

        return true; 
    }
};