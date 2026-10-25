import { getRole } from '../../../xy-config/config/permissions.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pendingRequests = new Map();
const DB_NAME = 'group_request_data';

// 🌟 防爆破内存缓存：记录【每个人】在【每个群】的申请时间戳
// 结构: Map<`${groupId}_${userId}`, number[]>
const userBlastTracker = new Map();

// 🌟 群预警缓存：记录每个群的总申请时间戳
const groupBlastTracker = new Map();

// 初始化本插件的数据库表
if (typeof globalThis.db === 'function') {
    globalThis.db('exec', {
        dbName: DB_NAME,
        sql: `CREATE TABLE IF NOT EXISTS request_settings (
            group_id TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            auto_process INTEGER DEFAULT 0,
            auto_answer TEXT DEFAULT '',
            anti_blast_enabled INTEGER DEFAULT 1,
            blast_max_count INTEGER DEFAULT 5,
            blast_time_window INTEGER DEFAULT 60
        )`
    });
    try { globalThis.db('exec', { dbName: DB_NAME, sql: 'ALTER TABLE request_settings ADD COLUMN anti_blast_enabled INTEGER DEFAULT 1' }); } catch(e){}
    try { globalThis.db('exec', { dbName: DB_NAME, sql: 'ALTER TABLE request_settings ADD COLUMN blast_max_count INTEGER DEFAULT 5' }); } catch(e){}
    try { globalThis.db('exec', { dbName: DB_NAME, sql: 'ALTER TABLE request_settings ADD COLUMN blast_time_window INTEGER DEFAULT 60' }); } catch(e){}
}

// 查询群管插件的黑名单数据库
function checkIsBanned(groupId, userId) {
    const possiblePaths = [
        path.resolve(__dirname, '../group-plugin/group_data.db'),
        path.resolve(__dirname, '../群管/group_data.db'),
        path.resolve(__dirname, '../../QQ/group-plugin/group_data.db'),
        path.resolve(__dirname, '../event-settings/group_data.db')
    ];
    let targetPath = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) { targetPath = p; break; }
    }
    if (!targetPath) return false;

    let db = null;
    try {
        db = new Database(targetPath, { readonly: true });
        const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='group_reject_list'`).get();
        if (!tableExists) return false;
        const row = db.prepare('SELECT user_id FROM group_reject_list WHERE group_id = ? AND user_id = ?').get(String(groupId), String(userId));
        return !!row; 
    } catch (e) {
        return false;
    } finally {
        if (db && db.open) db.close();
    }
}

// 🌟 将恶意用户写入群管黑名单
function addToBlacklist(groupId, userId, nickname, reason) {
    const possiblePaths = [
        path.resolve(__dirname, '../group-plugin/group_data.db'),
        path.resolve(__dirname, '../群管/group_data.db'),
        path.resolve(__dirname, '../../QQ/group-plugin/group_data.db'),
        path.resolve(__dirname, '../event-settings/group_data.db')
    ];
    let targetPath = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) { targetPath = p; break; }
    }
    if (!targetPath) return;

    let db = null;
    try {
        db = new Database(targetPath);
        db.prepare(`CREATE TABLE IF NOT EXISTS group_reject_list (
            group_id TEXT, user_id TEXT, nickname TEXT, create_time INTEGER, PRIMARY KEY(group_id, user_id)
        )`).run();
        db.prepare('INSERT OR REPLACE INTO group_reject_list (group_id, user_id, nickname, create_time) VALUES (?, ?, ?, ?)').run(
            String(groupId), String(userId), nickname || `爆破者(${reason})`, Math.floor(Date.now() / 1000)
        );
    } catch (e) {
        globalThis.print(`[入群申请] 写入黑名单失败: ${e.message}`);
    } finally {
        if (db && db.open) db.close();
    }
}

export default {
    name: '入群申请',
    events: ['group.request'],

    getGroupSettings(groupId) {
        const defaults = { 
            enabled: 0, auto_process: 0, auto_answer: '',
            anti_blast_enabled: 1, blast_max_count: 5, blast_time_window: 60
        };
        if (typeof globalThis.db !== 'function') return defaults;
        
        const res = globalThis.db('find', { dbName: DB_NAME, table: 'request_settings', where: 'group_id = ?', params: [String(groupId)], all: false });
        if (res.success && res.data) {
            return {
                enabled: res.data.enabled,
                auto_process: res.data.auto_process,
                auto_answer: res.data.auto_answer || '',
                anti_blast_enabled: res.data.anti_blast_enabled !== undefined ? res.data.anti_blast_enabled : 1,
                blast_max_count: res.data.blast_max_count || 5,
                blast_time_window: res.data.blast_time_window || 60
            };
        }
        return defaults;
    },

    setGroupSetting(groupId, key, value) {
        if (typeof globalThis.db !== 'function') return false;
        const gid = String(groupId);
        const check = globalThis.db('find', { dbName: DB_NAME, table: 'request_settings', where: 'group_id = ?', params: [gid], all: false });
        
        if (check.success && check.data) {
            globalThis.db('update', { dbName: DB_NAME, table: 'request_settings', set: { [key]: value }, where: 'group_id = ?', params: [gid] });
        } else {
            globalThis.db('insert', { dbName: DB_NAME, table: 'request_settings', data: { group_id: gid, [key]: value } });
        }
        return true;
    },

    async onEvent(e, conn) {
        if (e.event !== 'group.request') return;
        const raw = e.raw;
        if (raw.request_type !== 'group' || raw.sub_type !== 'add') return;

        const groupId = String(raw.group_id);
        const userId = String(raw.user_id);
        const flag = raw.flag;
        const comment = (raw.comment || '').trim();
        const now = Date.now();

        const settings = this.getGroupSettings(groupId);

        // 获取申请人昵称
        let nickname = '未知';
        try {
            const info = await globalThis.wsCall('get_stranger_info', { user_id: Number(userId) });
            nickname = info?.data?.nickname || nickname;
        } catch(e) {}

        // ==========================================
        // 🌟 第一道防线：精准防爆破（只抓恶意单号）
        // ==========================================
        if (settings.anti_blast_enabled === 1) {
            const trackerKey = `${groupId}_${userId}`;
            let userTimestamps = userBlastTracker.get(trackerKey) || [];
            
            // 过滤掉时间窗口之前的记录
            userTimestamps = userTimestamps.filter(t => now - t < settings.blast_time_window * 1000);
            userTimestamps.push(now);
            userBlastTracker.set(trackerKey, userTimestamps);

            // 判断单个人是否超限
            if (userTimestamps.length >= settings.blast_max_count) {
                userBlastTracker.delete(trackerKey); // 清空该人的记录
                globalThis.print(`[防爆破] 🚨 拦截到 ${nickname}(${userId}) 在 ${settings.blast_time_window}秒 内恶意申请 ${userTimestamps.length} 次！`);

                // 1. 拒绝他
                try {
                    await globalThis.wsCall('set_group_add_request', { flag, sub_type: raw.sub_type, approve: false, reason: '申请频率过高，疑似恶意爆破。' });
                } catch (err) {}

                // 2. 自动把他塞进本群的黑名单（永久拉黑）
                addToBlacklist(groupId, userId, nickname, '申请频率过高');

                // 3. 发群警告
                const noticeMsg = [{ 
                    type: 'text', 
                    data: { text: `🚨 【防爆破拦截】\n发现用户 ${nickname}(${userId}) 在短时间内疯狂申请入群。\n🛡️ 系统已自动拒绝申请，并将其永久拉入本群黑名单。` } 
                }];
                try { await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: noticeMsg }); } catch(e) {}
                return;
            }

            // 🌟 辅助：群流量预警（不拦截，只提醒）
            let groupTimestamps = groupBlastTracker.get(groupId) || [];
            groupTimestamps = groupTimestamps.filter(t => now - t < 10 * 1000); // 看10秒内的总流量
            groupTimestamps.push(now);
            groupBlastTracker.set(groupId, groupTimestamps);

            // 如果 10 秒内来了超过 10 个不同的人申请，提醒一下管理员（但不做拦截）
            if (groupTimestamps.length === 10) {
                const warnMsg = [{ type: 'text', data: { text: `⚠️ 【流量预警】本群在 10 秒内涌入了 10 个不同的入群申请。请管理员注意甄别，防止恶意炸群。` } }];
                try { await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: warnMsg }); } catch(e) {}
            }
        }

        // ==========================================
        // 第二道防线：黑名单自动秒拒
        // ==========================================
        const isBanned = checkIsBanned(groupId, userId);
        if (isBanned) {
            try {
                await globalThis.wsCall('set_group_add_request', { flag: flag, sub_type: raw.sub_type, approve: false, reason: '您已被本群加入黑名单，拒绝加入。' });
            } catch(err) {}
            return; 
        }

        // ==========================================
        // 第三道防线：常规入群逻辑
        // ==========================================
        if (settings.enabled !== 1) return;

        let botRole = 'member';
        try {
            const info = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: globalThis.botInfo?.qq });
            botRole = info?.data?.role;
        } catch(e) {}
        if (botRole !== 'owner' && botRole !== 'admin') return;

        if (settings.auto_process === 1 && settings.auto_answer) {
            const isMatch = comment.toLowerCase().includes(settings.auto_answer.toLowerCase());
            try {
                await globalThis.wsCall('set_group_add_request', {
                    flag: flag, sub_type: raw.sub_type, approve: isMatch, reason: isMatch ? '' : '入群附言验证错误'
                });

                const tipMsg = isMatch 
                    ? `🤖 已自动同意 ${nickname}(${userId}) 的入群申请。(附言验证通过)`
                    : `🤖 已自动拒绝 ${nickname}(${userId}) 的入群申请。(附言错误)`;

                await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text: tipMsg } }] });
                return; 
            } catch (err) {}
        }

        const noticeMsg = [
            { type: 'text', data: { text: `📥 收到新的入群申请：\n` } },
            { type: 'at', data: { qq: String(userId) } },
            { type: 'text', data: { text: ` (${nickname})\n附言：${comment || '无'}\n\n👉 请引用此条消息回复“同意”或“拒绝”。` } }
        ];

        try {
            const sendRes = await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: noticeMsg });
            const sentMessageId = sendRes?.data?.message_id;
            if (sentMessageId) {
                pendingRequests.set(String(sentMessageId), { groupId, userId, flag, subType: raw.sub_type });
            }
        } catch (e) {}
    },

    match(text) {
        if (typeof text !== 'string') return false;
        const cmd = text.trim();
        return cmd === '同意' || cmd === '拒绝' || 
               cmd === '开启入群申请' || cmd === '关闭入群申请' ||
               cmd === '开启自动处理' || cmd === '关闭自动处理' ||
               cmd === '开启防爆破' || cmd === '关闭防爆破' ||
               cmd.startsWith('设置入群答案');
    },

    async handle(msg) {
        if (!msg.isGroup) return false;
        
        let cmd = (msg.pureText || "").trim();
        const dynamicPrefixes = ['/', '$', '#', '!', '。'];
        for (const p of dynamicPrefixes) {
            if (cmd.startsWith(p)) { cmd = cmd.slice(p.length).trim(); break; }
        }

        const groupId = msg.chatId;
        const senderQQ = msg.senderQQ;

        let hasPermission = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
            if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
        } catch (e) {}
        
        if (!hasPermission && typeof getRole === 'function') {
            if (['master', 'owner'].includes(getRole(senderQQ))) hasPermission = true;
        }

        if (!hasPermission) return '❌ 权限不足：仅群主、管理员或主人可操作。';

        if (cmd === '关闭防爆破') {
            this.setGroupSetting(groupId, 'anti_blast_enabled', 0);
            return '✅ 已关闭本群防爆破保护。';
        }
        if (cmd === '开启防爆破') {
            this.setGroupSetting(groupId, 'anti_blast_enabled', 1);
            return '✅ 已开启防爆破保护（针对单人的高频申请进行拦截，多人正常加群不受影响）。';
        }

        if (cmd === '开启入群申请' || cmd === '关闭入群申请') {
            const enable = cmd === '开启入群申请';
            this.setGroupSetting(groupId, 'enabled', enable ? 1 : 0);
            return enable ? '✅ 已开启入群申请拦截，新申请将通知管理员。' : '✅ 已关闭入群申请拦截。';
        }

        if (cmd === '开启自动处理' || cmd === '关闭自动处理') {
            const enable = cmd === '开启自动处理';
            this.setGroupSetting(groupId, 'auto_process', enable ? 1 : 0);
            if (enable) {
                const settings = this.getGroupSettings(groupId);
                if (!settings.auto_answer) return '⚠️ 已开启自动处理，但尚未设置答案。请发送：设置入群答案 [答案]';
                return `✅ 已开启自动处理，附言包含 [${settings.auto_answer}] 将自动同意。`;
            }
            return '✅ 已关闭自动处理，恢复人工审批。';
        }

        if (cmd.startsWith('设置入群答案')) {
            const answer = cmd.replace('设置入群答案', '').trim();
            if (!answer) return '⚠️ 用法：设置入群答案 123';
            this.setGroupSetting(groupId, 'auto_answer', answer);
            return `✅ 已成功设置自动审批答案：【${answer}】。`;
        }

        if (cmd === '同意' || cmd === '拒绝') {
            let replyId = null;
            if (Array.isArray(msg.message)) {
                const replyItem = msg.message.find(item => item?.type === 'reply');
                if (replyItem && replyItem.data) {
                    replyId = replyItem.data.id || replyItem.data.message_id;
                }
            }

            if (!replyId) return '⚠️ 请引用入群申请的通知消息，再发送“同意”或“拒绝”。';

            const requestInfo = pendingRequests.get(String(replyId));
            if (!requestInfo) return '⚠️ 找不到该申请记录，可能已处理或已超时。';
            if (String(requestInfo.groupId) !== String(groupId)) return '❌ 错误：申请记录不属于当前群。';

            const isApprove = cmd === '同意';
            try {
                const res = await globalThis.wsCall('set_group_add_request', {
                    flag: requestInfo.flag, sub_type: requestInfo.subType, approve: isApprove, reason: isApprove ? '' : '管理员拒绝了你的入群申请'
                });

                if (res && (res.status === 'ok' || res.retcode === 0)) {
                    pendingRequests.delete(String(replyId));
                    return isApprove ? `✅ 已同意 ${requestInfo.userId} 的入群申请。` : `✅ 已拒绝 ${requestInfo.userId} 的入群申请。`;
                } else {
                    return `❌ 操作失败：${res?.msg || res?.message || '未知错误'}`;
                }
            } catch (e) {
                return `❌ 操作异常：${e.message}`;
            }
        }
    }
};