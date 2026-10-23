import { getRole } from '../../../xy-config/config/permissions.js';

// 缓存发出去的通知消息，用于管理员引用回复
const pendingRequests = new Map();
const DB_NAME = 'group_request_data';

// 初始化数据库表
if (typeof globalThis.db === 'function') {
    globalThis.db('exec', {
        dbName: DB_NAME,
        sql: `CREATE TABLE IF NOT EXISTS request_settings (
            group_id TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            auto_process INTEGER DEFAULT 0,
            auto_answer TEXT DEFAULT ''
        )`
    });
}

export default {
    name: '入群申请',
    events: ['group.request'],

    // 获取群的配置信息
    getGroupSettings(groupId) {
        const defaults = { enabled: 0, auto_process: 0, auto_answer: '' };
        if (typeof globalThis.db !== 'function') return defaults;
        
        const res = globalThis.db('find', {
            dbName: DB_NAME, table: 'request_settings', where: 'group_id = ?', params: [String(groupId)], all: false
        });
        if (res.success && res.data) {
            return {
                enabled: res.data.enabled,
                auto_process: res.data.auto_process,
                auto_answer: res.data.auto_answer || ''
            };
        }
        return defaults;
    },

    // 保存群的配置信息
    setGroupSetting(groupId, key, value) {
        if (typeof globalThis.db !== 'function') return false;
        const gid = String(groupId);
        const check = globalThis.db('find', { dbName: DB_NAME, table: 'request_settings', where: 'group_id = ?', params: [gid], all: false });
        
        if (check.success && check.data) {
            globalThis.db('update', {
                dbName: DB_NAME, table: 'request_settings', set: { [key]: value }, where: 'group_id = ?', params: [gid]
            });
        } else {
            globalThis.db('insert', {
                dbName: DB_NAME, table: 'request_settings', data: { group_id: gid, [key]: value }
            });
        }
        return true;
    },

    // 🌟 监听入群申请事件
    async onEvent(e, conn) {
        if (e.event !== 'group.request') return;
        const raw = e.raw;
        if (raw.request_type !== 'group' || raw.sub_type !== 'add') return;

        const groupId = raw.group_id;
        const userId = raw.user_id;
        const flag = raw.flag;
        const comment = (raw.comment || '').trim();

        const settings = this.getGroupSettings(groupId);
        
        // 1. 如果连“入群申请拦截”都没开启，直接无视（让协议端自己处理）
        if (settings.enabled !== 1) return;

        // 2. 检查 Bot 自身权限
        let botRole = 'member';
        try {
            const info = await globalThis.wsCall('get_group_member_info', { group_id: groupId, user_id: globalThis.botInfo?.qq });
            botRole = info?.data?.role;
        } catch(e) {}
        if (botRole !== 'owner' && botRole !== 'admin') return;

        // 获取申请人昵称
        let nickname = '未知';
        try {
            const info = await globalThis.wsCall('get_stranger_info', { user_id: userId });
            nickname = info?.data?.nickname || nickname;
        } catch(e) {}

        // ==========================================
        // 🌟 3. 自动处理逻辑
        // ==========================================
        if (settings.auto_process === 1 && settings.auto_answer) {
            // 判断附言是否包含预设答案（忽略大小写）
            const isMatch = comment.toLowerCase().includes(settings.auto_answer.toLowerCase());
            const isApprove = isMatch;

            try {
                await globalThis.wsCall('set_group_add_request', {
                    flag: flag,
                    sub_type: raw.sub_type,
                    approve: isApprove,
                    reason: isApprove ? '' : '入群附言验证错误'
                });

                const tipMsg = isApprove 
                    ? `🤖 已自动同意 ${nickname}(${userId}) 的入群申请。(附言验证通过)`
                    : `🤖 已自动拒绝 ${nickname}(${userId}) 的入群申请。(附言错误)`;

                await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text: tipMsg } }] });
                return; // 自动处理完，直接 return，不再发人工通知
            } catch (err) {
                globalThis.print(`[入群申请] 自动处理失败: ${err.message}`);
                // 如果自动处理失败，继续往下走，发给管理员人工处理
            }
        }

        // ==========================================
        // 4. 人工处理逻辑（发通知到群里）
        // ==========================================
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
        } catch (e) {
            globalThis.print(`[入群申请] 发送通知失败: ${e.message}`);
        }
    },

    // 🌟 匹配管理指令
    match(text) {
        if (typeof text !== 'string') return false;
        const cmd = text.trim();
        return cmd === '同意' || cmd === '拒绝' || 
               cmd === '开启入群申请' || cmd === '关闭入群申请' ||
               cmd === '开启自动处理' || cmd === '关闭自动处理' ||
               cmd.startsWith('设置入群答案');
    },

    async handle(msg) {
        if (!msg.isGroup) return false;
        const cmd = (msg.pureText || "").trim();
        const groupId = msg.chatId;
        const senderQQ = msg.senderQQ;

        // 鉴权：群主、管理员或全局主人
        let hasPermission = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
            if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
        } catch (e) {}
        
        if (!hasPermission && typeof getRole === 'function') {
            if (['master', 'owner'].includes(getRole(senderQQ))) hasPermission = true;
        }

        if (!hasPermission) return '❌ 权限不足：仅群主、管理员或主人可操作。';

        // ==========================================
        // 1. 开关配置类指令
        // ==========================================
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

        // ==========================================
        // 2. 引用回复指令 (同意/拒绝)
        // ==========================================
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
                    flag: requestInfo.flag,
                    sub_type: requestInfo.subType,
                    approve: isApprove,
                    reason: isApprove ? '' : '管理员拒绝了你的入群申请'
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