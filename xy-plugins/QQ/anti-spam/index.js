// xy-plugins/QQ/anti-spam/index.js
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'anti_spam.db');
const GLOBAL_CONFIG_PATH = path.join(process.cwd(), 'xy-config/config/config.yaml');

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

// 浏览器实例缓存
let spamBrowser = null;
let browserLaunching = null;

// 核心修改：按【群号】记录当前的连击状态
const groupTrackerMap = new Map();

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

        // ==========================================
        // 1. 管理指令解析
        // ==========================================
        const isCmd = cmd.startsWith('开启防刷屏') || cmd.startsWith('关闭防刷屏') || cmd.startsWith('查看防刷屏');

        if (isCmd) {
            let hasPermission = false;
            try {
                const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
                if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
            } catch (e) {}
            if (!hasPermission && typeof getRole === 'function') {
                if (['master', 'owner', 'admin'].includes(getRole(senderQQ))) hasPermission = true;
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

                const muteTip = muteDuration > 0 ? `禁言 ${muteDuration} 秒` : `仅撤回警告（不禁言）`;
                return `✅ 已开启防刷屏（连续发言判定）！\n⏱ 规则：${timeWindow} 秒内连续发 ${limitCount} 条消息\n🛡️ 处罚：超出限制将 ${muteTip}`;
            }

            if (cmd.startsWith('关闭防刷屏')) {
                db.prepare('UPDATE group_spam_settings SET enabled = 0 WHERE group_id = ?').run(groupId);
                return '✅ 已关闭本群防刷屏监控。';
            }

            if (cmd.startsWith('查看防刷屏')) {
                const row = db.prepare('SELECT * FROM group_spam_settings WHERE group_id = ?').get(groupId);
                if (!row || row.enabled === 0) {
                    return '⚙️ 本群防刷屏监控当前【未开启】。\n发送：开启防刷屏 [条数] [秒数] [禁言秒数]';
                }
                const muteTip = row.mute_duration > 0 ? `禁言 ${row.mute_duration} 秒` : `仅撤回警告（不禁言）`;
                return `⚙️ 本群防刷屏配置：\n⏱ 规则：${row.time_window} 秒内连续发 ${row.limit_count} 条消息\n🛡️ 处罚：${muteTip}`;
            }
            return false;
        }

        // ==========================================
        // 2. 刷屏检测逻辑（不管是谁，插话必归零）
        // ==========================================
        const settings = db.prepare('SELECT enabled, limit_count, time_window, mute_duration FROM group_spam_settings WHERE group_id = ?').get(groupId);
        if (!settings || settings.enabled === 0) return false;

        const { limit_count, time_window, mute_duration } = settings;
        const now = Date.now();

        // 🌟 第一步：先判断是不是连击被打断，更新记录
        let tracker = groupTrackerMap.get(groupId);

        if (!tracker || tracker.lastSenderQQ !== senderQQ) {
            // 换人了！包括群主/管理员插话，瞬间归零！重新开始计当前人的连击
            tracker = { lastSenderQQ: senderQQ, timestamps: [now] };
            groupTrackerMap.set(groupId, tracker);
        } else {
            // 还是同一个人在发，记录时间戳
            tracker.timestamps = tracker.timestamps.filter(t => now - t < time_window * 1000);
            tracker.timestamps.push(now);
        }

        // 🌟 第二步：判断发送者身份（豁免判定）
        let isExempt = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
            if (['owner', 'admin'].includes(res?.data?.role)) isExempt = true;
        } catch (e) {}
        if (isExempt || (typeof getRole === 'function' && ['master', 'owner', 'admin'].includes(getRole(senderQQ)))) {
            // 是管理员，虽然刚刚已经重置了连击记录，但**绝不处罚管理员**
            return false; 
        }

        // 🌟 第三步：普通群友，判断是否达到阈值
        if (tracker.timestamps.length >= limit_count) {
            groupTrackerMap.delete(groupId); // 处罚后清空该群追踪器
            
            globalThis.print(`[防刷屏] 🚨 拦截到 ${senderName}(${senderQQ}) 在 ${time_window}秒 内连续发送了 ${tracker.timestamps.length} 条消息！`);

            if (msg.message_id) {
                try { await globalThis.wsCall('delete_msg', { message_id: Number(msg.message_id) }); } catch (e) {}
            }

            let muteSuccess = false;
            if (mute_duration > 0) {
                try {
                    const res = await globalThis.wsCall('set_group_ban', { group_id: Number(groupId), user_id: Number(senderQQ), duration: mute_duration });
                    if (res.status === 'ok' || res.retcode === 0) muteSuccess = true;
                } catch (e) {}
            }

            const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${senderQQ}&s=640`;
            let themeColor = mute_duration > 0 ? '#F44336' : '#FF9800';
            let penaltyText = mute_duration > 0 ? `禁言 ${mute_duration} 秒` : `仅撤回警告`;
            if (mute_duration > 0 && !muteSuccess) penaltyText = '禁言失败(权限不足)';

            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; display: inline-block; }
                    .card { 
                        background: linear-gradient(145deg, #241a1a, #1e1414); 
                        border-radius: 20px; width: 460px; padding: 24px; 
                        border: 1px solid rgba(255, 100, 100, 0.2); 
                        box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5); position: relative; overflow: hidden;
                    }
                    .card::before {
                        content: ''; position: absolute; top: -50px; left: -50px; width: 150px; height: 150px;
                        background: ${themeColor}; filter: blur(80px); opacity: 0.25; z-index: 0;
                    }
                    .content { position: relative; z-index: 1; display: flex; align-items: center; gap: 16px; }
                    .avatar-box { flex-shrink: 0; width: 64px; height: 64px; border-radius: 50%; border: 2px solid ${themeColor}; box-shadow: 0 0 15px ${themeColor}60; overflow: hidden; position: relative; }
                    .avatar-box img { width: 100%; height: 100%; object-fit: cover; }
                    .badge { position: absolute; bottom: -2px; right: -2px; background: #1e1e24; border-radius: 50%; width: 24px; height: 24px; display: flex; justify-content: center; align-items: center; font-size: 14px; border: 1px solid rgba(255,255,255,0.1); }
                    .text-box { flex: 1; display: flex; flex-direction: column; gap: 6px; }
                    .title { font-size: 18px; color: ${themeColor}; font-weight: bold; }
                    .desc { font-size: 14px; color: #ddd; line-height: 1.5; }
                    .highlight { color: ${themeColor}; font-weight: bold; }
                    .footer { font-size: 12px; color: #777; margin-top: 12px; text-align: right; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="content">
                        <div class="avatar-box">
                            <img src="${avatarUrl}">
                            <div class="badge">⚠️</div>
                        </div>
                        <div class="text-box">
                            <div class="title">⚠️ 触发防刷屏警告</div>
                            <div class="desc">用户 <span class="highlight">${escapeHtml(senderName)}</span> 连续发言过快。<br>限制：<span class="highlight">${time_window}秒内连续${limit_count}条</span><br>处罚：<span class="highlight">${penaltyText}</span></div>
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
                    if (!spamBrowser || !spamBrowser.isConnected()) {
                        if (!browserLaunching) {
                            browserLaunching = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] }).then(b => {
                                spamBrowser = b; browserLaunching = null; return b;
                            });
                        }
                        await browserLaunching;
                    }
                    const ctx = await spamBrowser.newContext({ deviceScaleFactor: 2, viewport: { width: 600, height: 800 } });
                    const page = await ctx.newPage();
                    await page.setContent(html, { waitUntil: 'networkidle' });
                    const el = await page.$('.card');
                    imageBuffer = await el.screenshot({ type: 'png', omitBackground: true });
                    await ctx.close();
                }
            } catch (err) {
                console.error('❌ [防刷屏] 渲染图片失败:', err.message);
            }

            if (imageBuffer) {
                globalThis.bot.send({ chatId: Number(groupId), isGroup: true, file: imageBuffer });
            } else {
                globalThis.bot.send({ chatId: Number(groupId), isGroup: true, content: `⚠️ 警告：${senderName} 连续发言过快，已被${penaltyText}！` });
            }

            return true; 
        }

        return false;
    }
};