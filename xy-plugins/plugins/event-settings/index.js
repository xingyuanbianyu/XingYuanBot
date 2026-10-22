// xy-plugins/plugins/event-settings/index.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_NAME = 'group_data'; 

// 初始化数据库（默认建在当前插件目录下）
if (typeof globalThis.db === 'function') {
    globalThis.db('exec', {
        dbName: DB_NAME,
        sql: `CREATE TABLE IF NOT EXISTS group_event_settings (
            group_id TEXT PRIMARY KEY,
            welcome INTEGER DEFAULT 1,
            decrease INTEGER DEFAULT 1,
            kick INTEGER DEFAULT 1
        )`
    });
}

function getGroupSettings(groupId) {
    const gid = String(groupId);
    let settings = { welcome: 1, decrease: 1, kick: 1 };
    if (typeof globalThis.db === 'function') {
        const res = globalThis.db('find', {
            dbName: DB_NAME, table: 'group_event_settings', where: 'group_id = ?', params: [gid], all: false
        });
        if (res.success && res.data) {
            settings = { welcome: res.data.welcome, decrease: res.data.decrease, kick: res.data.kick };
        }
    }
    return settings;
}

export default {
    name: '群事件配置',
    
    // 纯指令匹配
    match(text) {
        if (!text || typeof text !== 'string') return false;
        return /^(开启|关闭)(入群|退群|踢人)提示$/.test(text.trim()) || text.trim() === '群事件设置';
    },

    async handle(msg) {
        const cmd = (msg.pureText || "").trim();
        const groupId = String(msg.chatId);
        const senderQQ = String(msg.senderQQ);

        if (!msg.isGroup) return '❌ 该指令仅限在群聊中使用。';

        let isAdmin = false;
        try {
            const res = await fetch(`http://127.0.0.1:3000/get_group_member_info?group_id=${groupId}&user_id=${senderQQ}`);
            const data = await res.json();
            if (data?.data?.role === 'owner' || data?.data?.role === 'admin') isAdmin = true;
        } catch(e) {}
        
        const configRole = getRole ? getRole(senderQQ) : 'member';
        const hasPermission = isAdmin || ['master', 'owner', 'admin'].includes(configRole);

        if (!hasPermission) return '❌ 权限不足：仅群主、管理员或主人可配置。';

        // 1. 查看
        if (cmd === '群事件设置') {
            const sets = getGroupSettings(groupId);
            return `⚙️ 本群事件提示配置：\n👋 入群提示：${sets.welcome ? '✅ 开启' : '❌ 关闭'}\n🚪 退群提示：${sets.decrease ? '✅ 开启' : '❌ 关闭'}\n👢 踢人提示：${sets.kick ? '✅ 开启' : '❌ 关闭'}\n\n💡 发送“开启入群提示”等指令可修改。`;
        }

        // 2. 修改
        const match = cmd.match(/^(开启|关闭)(入群|退群|踢人)提示$/);
        if (match) {
            const action = match[1] === '开启' ? 1 : 0;
            const type = match[2];

            let field = '';
            if (type === '入群') field = 'welcome';
            if (type === '退群') field = 'decrease';
            if (type === '踢人') field = 'kick';

            if (typeof globalThis.db === 'function') {
                const current = getGroupSettings(groupId);
                current[field] = action;
                
                const check = globalThis.db('find', { dbName: DB_NAME, table: 'group_event_settings', where: 'group_id = ?', params: [groupId], all: false });
                if (check.success && check.data) {
                    globalThis.db('update', {
                        dbName: DB_NAME, table: 'group_event_settings',
                        set: { [field]: action }, where: 'group_id = ?', params: [groupId]
                    });
                } else {
                    globalThis.db('insert', {
                        dbName: DB_NAME, table: 'group_event_settings',
                        data: {
                            group_id: groupId,
                            welcome: field === 'welcome' ? action : current.welcome,
                            decrease: field === 'decrease' ? action : current.decrease,
                            kick: field === 'kick' ? action : current.kick
                        }
                    });
                }
            }
            return `✅ 已成功【${match[1]}】本群的【${type}提示】。`;
        }
        return null;
    }
};