import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'group_data.db'); 

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS group_event_settings (
    group_id TEXT PRIMARY KEY,
    welcome INTEGER DEFAULT 1,
    decrease INTEGER DEFAULT 1,
    kick INTEGER DEFAULT 1
  )
`);

function getGroupSettings(groupId) {
    const gid = String(groupId);
    try {
        const row = db.prepare('SELECT welcome, decrease, kick FROM group_event_settings WHERE group_id = ?').get(gid);
        if (row) {
            return { 
                welcome: row.welcome, 
                decrease: row.decrease, 
                kick: row.kick 
            };
        }
    } catch (e) {}
    return { welcome: 1, decrease: 1, kick: 1 };
}

export default {
    name: '群事件配置',
    
    match(text) {
        if (!text || typeof text !== 'string') return false;
        const cmd = text.trim(); // 🌟 信任框架，直接 trim
        return /^(开启|关闭)(入群|退群|踢人)提示$/.test(cmd) || cmd === '群事件设置';
    },

    async handle(msg) {
        if (!msg.isGroup) return '❌ 该指令仅限在群聊中使用。';

        const cmd = (msg.pureText || "").trim(); // 🌟 信任框架，直接 trim
        const groupId = String(msg.chatId);
        const senderQQ = String(msg.senderQQ);
        const ws = msg._ws || globalThis.activeWs; 

        // 权限校验
        let isAdmin = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { 
                group_id: Number(groupId), 
                user_id: Number(senderQQ) 
            }, 3000, ws);
            
            // 兼容层级
            const role = res?.data?.role || res?.role;
            if (['owner', 'admin'].includes(role)) isAdmin = true;
        } catch(e) {}
        
        const configRole = typeof getRole === 'function' ? getRole(senderQQ, msg.botId) : 'member';
        const hasPermission = isAdmin || ['master', 'owner', 'admin'].includes(configRole);

        if (!hasPermission) return '❌ 权限不足：仅群主、管理员或主人可配置。';

        // 1. 查看配置
        if (cmd === '群事件设置') {
            const sets = getGroupSettings(groupId);
            return `⚙️ 本群事件提示配置：\n👋 入群提示：${sets.welcome ? '✅ 开启' : '❌ 关闭'}\n🚪 退群提示：${sets.decrease ? '✅ 开启' : '❌ 关闭'}\n👢 踢人提示：${sets.kick ? '✅ 开启' : '❌ 关闭'}\n\n💡 发送“开启入群提示”等指令可修改。`;
        }

        // 2. 修改配置
        const match = cmd.match(/^(开启|关闭)(入群|退群|踢人)提示$/);
        if (match) {
            const action = match[1] === '开启' ? 1 : 0;
            const type = match[2];

            let field = '';
            if (type === '入群') field = 'welcome';
            if (type === '退群') field = 'decrease';
            if (type === '踢人') field = 'kick';

            try {
                db.prepare(`
                    INSERT INTO group_event_settings (group_id, welcome, decrease, kick)
                    VALUES (@gid, @welcome, @decrease, @kick)
                    ON CONFLICT(group_id) DO UPDATE SET 
                        welcome = CASE WHEN @field = 'welcome' THEN @action ELSE welcome END,
                        decrease = CASE WHEN @field = 'decrease' THEN @action ELSE decrease END,
                        kick = CASE WHEN @field = 'kick' THEN @action ELSE kick END
                `).run({
                    gid: groupId,
                    welcome: field === 'welcome' ? action : 1,
                    decrease: field === 'decrease' ? action : 1,
                    kick: field === 'kick' ? action : 1,
                    field: field,
                    action: action
                });

                return `✅ 已成功【${match[1]}】本群的【${type}提示】。`;
            } catch (e) {
                globalThis.print(`[群事件配置] 数据库写入失败: ${e.message}`);
                return `❌ 修改失败，请查看后台日志。`;
            }
        }
        return null;
    }
};