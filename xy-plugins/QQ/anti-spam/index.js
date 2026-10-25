import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'anti_spam.db');
// 🌟 修复：绝对路径
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

// 🌟 性能核心 1：缓存群设置，避免每条消息都查库
const spamSettingsCache = new Map(); 
function getSettings(groupId) {
    if (spamSettingsCache.has(groupId)) return spamSettingsCache.get(groupId);
    const row = db.prepare('SELECT * FROM group_spam_settings WHERE group_id = ?').get(groupId);
    spamSettingsCache.set(groupId, row);
    return row;
}

let spamBrowser = null;
let browserLaunching = null;
const groupTrackerMap = new Map();

// 🌟 性能核心 2：定时清理僵尸群，防止内存泄漏
setInterval(() => {
    const now = Date.now();
    for (const [groupId, tracker] of groupTrackerMap.entries()) {
        // 如果最后一条消息是 10 分钟前，清理掉这个群的追踪器
        if (tracker.timestamps.length === 0 || now - tracker.timestamps[tracker.timestamps.length - 1] > 10 * 60 * 1000) {
            groupTrackerMap.delete(groupId);
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
    return prefixes;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
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
        const ws = msg._ws; // 🌟 统一获取

        // ==========================================
        // 1. 管理指令解析
        // ==========================================
        const isCmd = cmd.startsWith('开启防刷屏') || cmd.startsWith('关闭防刷屏') || cmd.startsWith('查看防刷屏');

        if (isCmd) {
            let hasPermission = false;
            
            // 查缓存命中
            const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
            const member = cachedMembers.find(m => String(m.user_id) === senderQQ);
            if (member && ['owner', 'admin'].includes(member.role)) hasPermission = true;
            else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ))) hasPermission = true;
            else {
                try {
                    const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) }, 3000, ws);
                    if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
                } catch (e) {}
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
                
                spamSettingsCache.delete(groupId); // 🌟 清空缓存，强制下次读取新配置

                const muteTip = muteDuration > 0 ? `禁言 ${muteDuration} 秒` : `仅撤回警告（不禁言）`;
                return `✅ 已开启防刷屏（连续发言判定）！\n⏱ 规则：${timeWindow} 秒内连续发 ${limitCount} 条消息\n🛡️ 处罚：超出限制将 ${muteTip}`;
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
                const muteTip = row.mute_duration > 0 ? `禁言 ${row.mute_duration} 秒` : `仅撤回警告（不禁言）`;
                return `⚙️ 本群防刷屏配置：\n⏱ 规则：${row.time_window} 秒内连续发 ${row.limit_count} 条消息\n🛡️ 处罚：${muteTip}`;
            }
            return false;
        }

        // ==========================================
        // 2. 刷屏检测逻辑
        // ==========================================
        // 🌟 性能核心 3：如果没开启，瞬间放行，杜绝任何 API 请求
        const settings = getSettings(groupId);
        if (!settings || settings.enabled === 0) return false;

        const { limit_count, time_window, mute_duration } = settings;
        const now = Date.now();

        // 判断连击
        let tracker = groupTrackerMap.get(groupId);
        if (!tracker || tracker.lastSenderQQ !== senderQQ) {
            tracker = { lastSenderQQ: senderQQ, timestamps: [now] };
            groupTrackerMap.set(groupId, tracker);
        } else {
            tracker.timestamps = tracker.timestamps.filter(t => now - t < time_window * 1000);
            tracker.timestamps.push(now);
        }

        // 🌟 性能核心 4：还没达到触发阈值，直接 return！此时只需要内存操作，零 API 请求！
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
        else if (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ))) isExempt = true;

        if (isExempt) {
            // 管理员刚刚已经重置了连击记录，直接放行
            return false; 
        }

        // ==========================================
        // 4. 执行处罚
        // ==========================================
        groupTrackerMap.delete(groupId); // 处罚后清空
        
        globalThis.print(`[防刷屏] 🚨 拦截到 ${senderName}(${senderQQ}) 在 ${time_window}秒 内连续发送了 ${tracker.timestamps.length} 条消息！`);

        if (msg.message_id) {
            try { await globalThis.wsCall('delete_msg', { message_id: Number(msg.message_id) }, 3000, ws); } catch (e) {}
        }

        let muteSuccess = false;
        if (mute_duration > 0) {
            try {
                const res = await globalThis.wsCall('set_group_ban', { group_id: Number(groupId), user_id: Number(senderQQ), duration: mute_duration }, 3000, ws);
                if (res.status === 'ok' || res.retcode === 0) muteSuccess = true;
            } catch (e) {}
        }

        const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${senderQQ}&s=640`;
        let themeColor = mute_duration > 0 ? '#F44336' : '#FF9800';
        let penaltyText = mute_duration > 0 ? `禁言 ${mute_duration} 秒` : `仅撤回警告`;
        if (mute_duration > 0 && !muteSuccess) penaltyText = '禁言失败(权限不足)';

        // ... [HTML 渲染代码完全保留你的，这里折叠] ...
        const html = `...`; // 把之前的 HTML 原样粘贴回来

        let imageBuffer = null;
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
                try { // 🌟 修复 Context 泄漏
                    const page = await ctx.newPage();
                    await page.setContent(html, { waitUntil: 'networkidle' });
                    const el = await page.$('.card');
                    imageBuffer = await el.screenshot({ type: 'png', omitBackground: true });
                } finally {
                    await ctx.close().catch(()=>{});
                }
            }
        } catch (err) {
            console.error('❌ [防刷屏] 渲染图片失败:', err.message);
        }

        if (imageBuffer) {
            globalThis.bot.send({ chatId: Number(groupId), isGroup: true, file: imageBuffer, botId: msg.botId, _ws: ws });
        } else {
            globalThis.bot.send({ chatId: Number(groupId), isGroup: true, content: `⚠️ 警告：${senderName} 连续发言过快，已被${penaltyText}！`, botId: msg.botId, _ws: ws });
        }

        return true; 
    }
};