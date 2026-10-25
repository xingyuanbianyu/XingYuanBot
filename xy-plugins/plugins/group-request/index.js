import { getRole } from '../../../xy-config/config/permissions.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'request_data.db');

// 🌟 抛弃魔法，使用原生 SQLite
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS request_settings (
    group_id TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    auto_process INTEGER DEFAULT 0,
    auto_answer TEXT DEFAULT '[]', 
    anti_blast_enabled INTEGER DEFAULT 1,
    blast_max_count INTEGER DEFAULT 5,
    blast_time_window INTEGER DEFAULT 60
  )
`);
try { db.exec('ALTER TABLE request_settings ADD COLUMN anti_blast_enabled INTEGER DEFAULT 1'); } catch(e){}
try { db.exec('ALTER TABLE request_settings ADD COLUMN blast_max_count INTEGER DEFAULT 5'); } catch(e){}
try { db.exec('ALTER TABLE request_settings ADD COLUMN blast_time_window INTEGER DEFAULT 60'); } catch(e){}

const pendingRequests = new Map();
const userBlastTracker = new Map();
const groupBlastTracker = new Map();

// 🌟 核心优化 1：定时清理过期数据，防止内存泄漏
setInterval(() => {
    const now = Date.now();
    
    // 清理超过 10 分钟没被处理的申请记录
    for (const [id, req] of pendingRequests.entries()) {
        if (now - req.createTime > 10 * 60 * 1000) {
            pendingRequests.delete(id);
        }
    }

    // 清理超过 5 分钟没动静的爆破记录
    for (const [key, timestamps] of userBlastTracker.entries()) {
        if (timestamps.length === 0 || now - timestamps[timestamps.length - 1] > 5 * 60 * 1000) {
            userBlastTracker.delete(key);
        }
    }
    for (const [gid, timestamps] of groupBlastTracker.entries()) {
        if (timestamps.length === 0 || now - timestamps[timestamps.length - 1] > 5 * 60 * 1000) {
            groupBlastTracker.delete(gid);
        }
    }
}, 60 * 1000);

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

    let readDb = null;
    try {
        readDb = new Database(targetPath, { readonly: true, fileMustExist: true });
        // 🌟 增加表存在性校验，防止因为没有表直接报错导致插件崩溃
        const tableExists = readDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='group_reject_list'`).get();
        if (!tableExists) return false;
        
        const row = readDb.prepare('SELECT user_id FROM group_reject_list WHERE group_id = ? AND user_id = ?').get(String(groupId), String(userId));
        return !!row; 
    } catch (e) {
        return false;
    } finally {
        if (readDb && readDb.open) readDb.close();
    }
}

// 将恶意用户写入群管黑名单
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

    let writeDb = null;
    try {
        writeDb = new Database(targetPath);
        writeDb.pragma('journal_mode = WAL'); // 开启 WAL 提高并发写入能力
        writeDb.prepare(`CREATE TABLE IF NOT EXISTS group_reject_list (
            group_id TEXT, user_id TEXT, nickname TEXT, create_time INTEGER, PRIMARY KEY(group_id, user_id)
        )`).run();
        writeDb.prepare('INSERT OR REPLACE INTO group_reject_list (group_id, user_id, nickname, create_time) VALUES (?, ?, ?, ?)').run(
            String(groupId), String(userId), nickname || `爆破者(${reason})`, Math.floor(Date.now() / 1000)
        );
    } catch (e) {
        globalThis.print(`[入群申请] 写入黑名单失败: ${e.message}`);
    } finally {
        if (writeDb && writeDb.open) writeDb.close();
    }
}

export default {
    name: '入群申请',
    events: ['group.request'],

    getGroupSettings(groupId) {
        const defaults = { 
            enabled: 0, auto_process: 0, auto_answers: [],
            anti_blast_enabled: 1, blast_max_count: 5, blast_time_window: 60
        };
        
        try {
            const row = db.prepare('SELECT * FROM request_settings WHERE group_id = ?').get(String(groupId));
            if (row) {
                let answers = [];
                try {
                    const rawAns = row.auto_answer || '[]';
                    if (rawAns.startsWith('[')) {
                        answers = JSON.parse(rawAns);
                    } else if (rawAns) {
                        answers = [rawAns];
                    }
                } catch(e) { answers = []; }

                return {
                    enabled: row.enabled,
                    auto_process: row.auto_process,
                    auto_answers: answers,
                    anti_blast_enabled: row.anti_blast_enabled !== undefined ? row.anti_blast_enabled : 1,
                    blast_max_count: row.blast_max_count || 5,
                    blast_time_window: row.blast_time_window || 60
                };
            }
        } catch (e) {}
        return defaults;
    },

    setGroupSetting(groupId, key, value) {
        try {
            const gid = String(groupId);
            let storeValue = value;
            if (key === 'auto_answer' && Array.isArray(value)) {
                storeValue = JSON.stringify(value);
            }
            
            db.prepare(`
                INSERT INTO request_settings (group_id, ${key}) VALUES (?, ?)
                ON CONFLICT(group_id) DO UPDATE SET ${key} = excluded.${key}
            `).run(gid, storeValue);
            return true;
        } catch (e) { return false; }
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
        
        // 🌟 核心修复：从 sharedState 找精准的 ws
        const selfId = String(e.selfId || raw.self_id || '');
        let ws = conn?.ws;
        if (!ws && selfId && globalThis.sharedState?.botIdToWs) {
            ws = globalThis.sharedState.botIdToWs.get(selfId);
        }

        const settings = this.getGroupSettings(groupId);

        // 获取申请人昵称
        let nickname = '未知';
        try {
            const info = await globalThis.wsCall('get_stranger_info', { user_id: Number(userId) }, 3000, ws);
            nickname = info?.data?.nickname || nickname;
        } catch(e) {}

        // ==========================================
        // 🌟 第一道防线：精准防爆破
        // ==========================================
        if (settings.anti_blast_enabled === 1) {
            const trackerKey = `${groupId}_${userId}`;
            let userTimestamps = userBlastTracker.get(trackerKey) || [];
            
            userTimestamps = userTimestamps.filter(t => now - t < settings.blast_time_window * 1000);
            userTimestamps.push(now);
            userBlastTracker.set(trackerKey, userTimestamps);

            if (userTimestamps.length >= settings.blast_max_count) {
                userBlastTracker.delete(trackerKey); 
                globalThis.print(`[防爆破] 🚨 拦截到 ${nickname}(${userId}) 在 ${settings.blast_time_window}秒 内恶意申请 ${userTimestamps.length} 次！`);

                try {
                    await globalThis.wsCall('set_group_add_request', { flag, sub_type: raw.sub_type, approve: false, reason: '申请频率过高，疑似恶意爆破。' }, 3000, ws);
                } catch (err) {}

                addToBlacklist(groupId, userId, nickname, '申请频率过高');

                const noticeMsg = [{ type: 'text', data: { text: `🚨 【防爆破拦截】\n发现用户 ${nickname}(${userId}) 在短时间内疯狂申请入群。\n🛡️ 系统已自动拒绝申请，并将其永久拉入本群黑名单。` } }];
                try { await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: noticeMsg }, 3000, ws); } catch(e) {}
                return;
            }

            let groupTimestamps = groupBlastTracker.get(groupId) || [];
            groupTimestamps = groupTimestamps.filter(t => now - t < 10 * 1000); 
            groupTimestamps.push(now);
            groupBlastTracker.set(groupId, groupTimestamps);

            if (groupTimestamps.length === 10) {
                const warnMsg = [{ type: 'text', data: { text: `⚠️ 【流量预警】本群在 10 秒内涌入了 10 个不同的入群申请。请管理员注意甄别，防止恶意炸群。` } }];
                try { await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: warnMsg }, 3000, ws); } catch(e) {}
            }
        }

        // ==========================================
        // 第二道防线：黑名单自动秒拒
        // ==========================================
        const isBanned = checkIsBanned(groupId, userId);
        if (isBanned) {
            try {
                await globalThis.wsCall('set_group_add_request', { flag: flag, sub_type: raw.sub_type, approve: false, reason: '您已被本群加入黑名单，拒绝加入。' }, 3000, ws);
            } catch(err) {}
            return; 
        }

        // ==========================================
        // 第三道防线：常规入群逻辑
        // ==========================================
        if (settings.enabled !== 1) return;

        let botRole = 'member';
        try {
            const info = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: globalThis.botInfo?.qq }, 3000, ws);
            botRole = info?.data?.role;
        } catch(e) {}
        
        if (botRole !== 'owner' && botRole !== 'admin') return;

        // 🌟 核心：多答案匹配
        if (settings.auto_process === 1 && settings.auto_answers.length > 0) {
            const lowerComment = comment.toLowerCase();
            const isMatch = settings.auto_answers.some(ans => ans && lowerComment.includes(ans.toLowerCase()));
            
            try {
                await globalThis.wsCall('set_group_add_request', {
                    flag: flag, sub_type: raw.sub_type, approve: isMatch, reason: isMatch ? '' : '入群附言验证错误'
                }, 3000, ws);

                const tipMsg = isMatch 
                    ? `🤖 已自动同意 ${nickname}(${userId}) 的入群申请。(附言验证通过)`
                    : `🤖 已自动拒绝 ${nickname}(${userId}) 的入群申请。(附言错误)`;

                await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text: tipMsg } }] }, 3000, ws);
                return; 
            } catch (err) {}
        }

        const noticeMsg = [
            { type: 'text', data: { text: `📥 收到新的入群申请：\n` } },
            { type: 'at', data: { qq: String(userId) } },
            { type: 'text', data: { text: ` (${nickname})\n附言：${comment || '无'}\n\n👉 请引用此条消息回复“同意”或“拒绝”。` } }
        ];

        try {
            const sendRes = await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: noticeMsg }, 3000, ws);
            const sentMessageId = sendRes?.data?.message_id;
            if (sentMessageId) {
                // 🌟 记录 createTime 方便后续定时清理
                pendingRequests.set(String(sentMessageId), { 
                    groupId, userId, flag, subType: raw.sub_type, createTime: Date.now() 
                });
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
               cmd === '查看入群答案' || cmd === '清空入群答案' ||
               cmd.startsWith('添加入群答案') || cmd.startsWith('删除入群答案');
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
        const ws = msg._ws; // 🌟 统一获取 ws

        let hasPermission = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) }, 3000, ws);
            if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
        } catch (e) {}
        
        if (!hasPermission && typeof getRole === 'function') {
            if (['master', 'owner'].includes(getRole(senderQQ))) hasPermission = true;
        }
        if (!hasPermission) return '❌ 权限不足：仅群主、管理员或主人可操作。';

        if (cmd === '查看入群答案') {
            const settings = this.getGroupSettings(groupId);
            if (settings.auto_answers.length === 0) return '📭 当前未设置任何入群答案。';
            
            let reply = `📋 本群入群答案（共 ${settings.auto_answers.length} 个）：\n\n`;
            settings.auto_answers.forEach((ans, index) => {
                reply += `[索引 ${index + 1}] ${ans}\n`;
            });
            return reply.trim() + `\n\n💡 发送：删除入群答案 [索引] 可删除对应答案。`;
        }

        if (cmd.startsWith('添加入群答案')) {
            const answer = cmd.replace('添加入群答案', '').trim();
            if (!answer) return '⚠️ 用法：添加入群答案 内容';

            const settings = this.getGroupSettings(groupId);
            let answers = settings.auto_answers || [];
            
            if (answers.includes(answer)) return `⚠️ 答案【${answer}】已存在，无需重复添加。`;

            answers.push(answer);
            this.setGroupSetting(groupId, 'auto_answer', answers);
            return `✅ 已成功添加入群答案：【${answer}】\n(当前共 ${answers.length} 个答案)`;
        }

        if (cmd.startsWith('删除入群答案')) {
            const indexStr = cmd.replace('删除入群答案', '').trim();
            const index = parseInt(indexStr) - 1; 
            if (isNaN(index) || index < 0) return '⚠️ 用法：删除入群答案 [索引]（请先发送 查看入群答案）';

            const settings = this.getGroupSettings(groupId);
            let answers = settings.auto_answers || [];
            
            if (index >= answers.length) return '⚠️ 索引越界：找不到该答案，请先发送 查看入群答案。';

            const removed = answers.splice(index, 1)[0];
            this.setGroupSetting(groupId, 'auto_answer', answers);
            return `✅ 已成功删除答案：【${removed}】\n(当前剩余 ${answers.length} 个答案)`;
        }

        if (cmd === '清空入群答案') {
            this.setGroupSetting(groupId, 'auto_answer', []);
            return '✅ 已清空本群所有入群答案。';
        }

        if (cmd === '关闭防爆破') {
            this.setGroupSetting(groupId, 'anti_blast_enabled', 0);
            return '✅ 已关闭本群防爆破保护。';
        }
        if (cmd === '开启防爆破') {
            this.setGroupSetting(groupId, 'anti_blast_enabled', 1);
            return '✅ 已开启防爆破保护。';
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
                if (settings.auto_answers.length === 0) return '⚠️ 已开启自动处理，但尚未设置答案。请发送：添加入群答案 [内容]';
                return `✅ 已开启自动处理，附言包含已设置的任意答案即可自动同意。`;
            }
            return '✅ 已关闭自动处理，恢复人工审批。';
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
                }, 5000, ws); // 🌟 补上 ws

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