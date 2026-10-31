import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'alias.db');
const GLOBAL_CONFIG_PATH = path.resolve(__dirname, '../../../xy-config/config.yaml');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS group_aliases (
    group_id TEXT,
    alias_cmd TEXT,
    original_cmd TEXT,
    PRIMARY KEY(group_id, alias_cmd)
  )
`);

// 🌟 优化 1：加入管理员权限缓存，防止 API 被频繁调用导致风控
const adminCache = new Map();

// 清洗前缀
function cleanPrefix(str) {
    if (!str) return '';
    let s = str.trim();
    let prefixes = ['/', '$', '#', '!', '。', '.'];
    try {
        if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
            const authConfig = yaml.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) || {};
            if (authConfig.command_prefix && Array.isArray(authConfig.command_prefix.prefixes)) {
                prefixes = authConfig.command_prefix.prefixes;
            }
        }
    } catch (e) {}
    
    // 🌟 优化 2：按长度倒序排序，防止类似前缀 "!!" 被 "!" 抢先截断
    prefixes.sort((a, b) => b.length - a.length);
    
    for (const p of prefixes) {
        if (s.startsWith(p)) { 
            s = s.slice(p.length).trim(); 
            break; 
        }
    }
    return s;
}

export default {
    name: '指令映射',
    
    // 🌟 修复 1：匹配前先洗掉前缀，防止用户发 "#指令映射" 匹配不到
    match(text) {
        if (!text || typeof text !== 'string') return false;
        // 这里不需要 trim()，因为 cleanPrefix 内部会处理
        const cmd = cleanPrefix(text);
        return cmd.startsWith('指令映射') || cmd.startsWith('删除映射') || cmd.startsWith('查看映射');
    },

    async handle(msg) {
        if (!msg.isGroup) return false;

        // 🌟 修复 2：这里也洗掉前缀
        let cmd = cleanPrefix(msg.pureText || "");
        const groupId = String(msg.chatId);
        const senderQQ = String(msg.senderQQ);
        const ws = msg._ws || globalThis.activeWs; 
        
        let isMaster = false;      
        let isLocalAdmin = false;  
        
        if (typeof getRole === 'function') {
            const role = getRole(senderQQ, msg.botId);
            if (['master', 'owner'].includes(role)) isMaster = true;
            if (['admin'].includes(role)) isLocalAdmin = true;
        }

        // 🌟 优化 3：查缓存权限，减少 wsCall 请求
        const cacheKey = `${groupId}_${senderQQ}`;
        const cachedRole = adminCache.get(cacheKey);
        
        if (!isMaster && !isLocalAdmin) {
            if (cachedRole && cachedRole.expire > Date.now()) {
                isLocalAdmin = cachedRole.isAdmin;
            } else {
                try {
                    const res = await globalThis.wsCall('get_group_member_info', { 
                        group_id: Number(groupId), 
                        user_id: Number(senderQQ) 
                    }, 3000, ws);
                    
                    // 🌟 修复 3：兼容不带 data 的返回层级
                    const role = res?.data?.role || res?.role;
                    if (['owner', 'admin'].includes(role)) isLocalAdmin = true;
                    
                    // 缓存 5 分钟
                    adminCache.set(cacheKey, { isAdmin: isLocalAdmin, expire: Date.now() + 300000 });
                } catch (e) {}
            }
        }

        if (!isMaster && !isLocalAdmin) {
            return '❌ 权限不足：仅群主、管理员或主人可配置映射。';
        }

        // ==========================================
        // 1. 添加映射
        // ==========================================
        if (cmd.startsWith('指令映射')) {
            const rawArgs = cmd.replace('指令映射', '').trim();
            if (!rawArgs) return '⚠️ 用法：指令映射 [原指令系列] [新指令名]\n💡 如果指令带空格，请用引号包裹新指令名，例如：\n指令映射 $禁言 {QQ} 5分钟 "天选之人"';

            let original, alias;
            // 🌟 优化 4：增强正则，兼容中英文引号，并允许末尾没有引号的情况下按空格切分
            const quoteMatch = rawArgs.match(/^(.*?)\s*["'](.*?)["']$/);
            if (quoteMatch) {
                original = quoteMatch[1].trim();
                alias = quoteMatch[2].trim();
            } else {
                const args = rawArgs.split(/\s+/);
                if (args.length < 2) return '⚠️ 格式错误！至少需要两个词。';
                alias = args.pop(); // 取最后一个词
                original = args.join(' ');
            }

            original = cleanPrefix(original);
            alias = cleanPrefix(alias);

            if (!original || !alias) return '❌ 参数不能为空。';
            if (original === alias) return '❌ 原指令和新指令不能一样。';

            // 🌟 优化 5：防止超长字符串撑爆数据库或导致底层解析引擎卡死
            if (original.length > 100 || alias.length > 30) {
                return '❌ 长度超限：原指令不能超过100字符，别名不能超过30字符。';
            }

            // 检查冲突
            const existingGlobal = db.prepare('SELECT original_cmd FROM group_aliases WHERE group_id = ? AND alias_cmd = ?').get('global', alias);
            const existingLocal = db.prepare('SELECT original_cmd FROM group_aliases WHERE group_id = ? AND alias_cmd = ?').get(groupId, alias);

            if (isMaster) {
                db.prepare('INSERT OR REPLACE INTO group_aliases (group_id, alias_cmd, original_cmd) VALUES (?, ?, ?)').run('global', alias, original);
                if (typeof globalThis._loadCommandAliases === 'function') await globalThis._loadCommandAliases();
                
                const overridden = existingGlobal ? `（覆盖了旧全局映射 ${existingGlobal.original_cmd}）` : '';
                return `✅ 【全局映射】成功！${overridden}\n(您是大主人) 任何群发送【${alias}】都会执行【${original}】。`;
            } else if (isLocalAdmin) {
                db.prepare('INSERT OR REPLACE INTO group_aliases (group_id, alias_cmd, original_cmd) VALUES (?, ?, ?)').run(groupId, alias, original);
                if (typeof globalThis._loadCommandAliases === 'function') await globalThis._loadCommandAliases();
                
                const overridden = existingLocal ? `（覆盖了旧局部映射 ${existingLocal.original_cmd}）` : '';
                // 提醒群管：如果跟全局映射同名，底层通常是局部覆盖全局，但也可能产生歧义
                const globalTip = existingGlobal ? `\n⚠️ 注意：此别名在全局也存在（指向 ${existingGlobal.original_cmd}），当前将优先执行您的本群设置。` : '';
                return `✅ 【局部映射】成功！${overridden}${globalTip}\n(您是群管) 本群发送【${alias}】将执行【${original}】。`;
            }
        }

        // ==========================================
        // 2. 删除映射
        // ==========================================
        if (cmd.startsWith('删除映射')) {
            let alias = cmd.replace('删除映射', '').trim();
            alias = cleanPrefix(alias);
            if (!alias) return '⚠️ 用法：删除映射 [新指令]';

            let deleted = false;
            let delType = '';

            // 优先删全局，再删局部？为了严谨，按照权限级别删
            if (isMaster) {
                const info = db.prepare('DELETE FROM group_aliases WHERE group_id = ? AND alias_cmd = ?').run('global', alias);
                if (info.changes > 0) { deleted = true; delType = '全局'; }
            }

            if (!deleted) {
                const info = db.prepare('DELETE FROM group_aliases WHERE group_id = ? AND alias_cmd = ?').run(groupId, alias);
                if (info.changes > 0) { deleted = true; delType = '局部'; }
            }

            if (deleted) {
                if (typeof globalThis._loadCommandAliases === 'function') await globalThis._loadCommandAliases();
                return `✅ 已删除【${delType}】映射【${alias}】。`;
            }
            return `⚠️ 找不到名为【${alias}】的映射。`;
        }

        // ==========================================
        // 3. 查看映射
        // ==========================================
        if (cmd.startsWith('查看映射')) {
            const globalRows = db.prepare('SELECT * FROM group_aliases WHERE group_id = ?').all('global');
            const localRows = db.prepare('SELECT * FROM group_aliases WHERE group_id = ?').all(groupId);

            if (globalRows.length === 0 && localRows.length === 0) return '📭 暂无任何映射规则。';

            // 🌟 优化 6：如果映射过多，消息可能超长导致发送失败，这里做个安全截断
            let reply = `📊 指令映射列表：\n\n🌐 【全局映射】\n`;
            if (globalRows.length > 0) globalRows.forEach((r, i) => reply += `  ${i + 1}. 【${r.alias_cmd}】 ➡️ 【${r.original_cmd}】\n`);
            else reply += `  暂无\n`;

            reply += `\n📍 【本群局部映射】\n`;
            if (localRows.length > 0) localRows.forEach((r, i) => reply += `  ${i + 1}. 【${r.alias_cmd}】 ➡️ 【${r.original_cmd}】\n`);
            else reply += `  暂无\n`;

            reply += `\n💡 发送指令时，优先匹配本群局部映射。`;
            
            if (reply.length > 2500) {
                return reply.substring(0, 2400) + '\n\n... (列表过长，已截断显示)';
            }
            return reply.trim();
        }
    }
};