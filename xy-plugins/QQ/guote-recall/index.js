import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, 'todo.db');

const db = new Database(dbPath); 
db.pragma('journal_mode = WAL'); 

db.exec(`
  CREATE TABLE IF NOT EXISTS group_todos (
    group_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )
`);

console.log('✅ 群管数据库初始化完成 (ESM模式)');

// 🌟 优化 1：统一 API 成功判定标准
function isApiSuccess(res) {
    if (res === null || res === undefined) return true; 
    if (typeof res === 'object') {
        if (res.status === 'ok' || res.retcode === 0 || res.retcode === 1) return true;
    }
    return false;
}

// 🌟 Bot 权限缓存，减少 API 调用
const botPermCache = new Map(); // groupId -> { hasPerm: boolean, time: number }

async function checkBotPermission(chatId, ws) {
    if (typeof globalThis.wsCall !== 'function') return false;
    
    const gid = String(chatId);
    const cached = botPermCache.get(gid);
    if (cached && Date.now() - cached.time < 60000) { // 缓存 1 分钟
        return cached.hasPerm;
    }

    try {
        const botData = await globalThis.wsCall('get_login_info', {}, 3000, ws);
        const botQQ = botData?.data?.user_id || botData?.user_id || globalThis.botInfo?.qq;
        if (!botQQ) return false;

        const info = await globalThis.wsCall('get_group_member_info', {
            group_id: Number(chatId),
            user_id: Number(botQQ),
            no_cache: true
        }, 3000, ws);
        
        const role = info?.data?.role || info?.role;
        const hasPerm = role === 'owner' || role === 'admin';
        
        if (role) {
            botPermCache.set(gid, { hasPerm, time: Date.now() });
        }
        return hasPerm;
    } catch (e) {
        return false;
    }
}

// 智能安全撤回函数
async function safeDeleteMessage(chatId, messageId, ws) {
    if (typeof globalThis.wsCall !== 'function') return '❌ 框架底层未就绪';
    
    try {
        // 🌟 强制清理 ID 中的杂字符
        const cleanId = String(messageId).replace(/[^0-9-]/g, '');
        const result = await globalThis.wsCall('delete_msg', { message_id: cleanId }, 5000, ws);
        
        if (isApiSuccess(result)) {
            return true;
        }
        return `❌ 撤回失败：${result?.msg || result?.message || '未知错误'}`;
    } catch (e) {
        const errMsg = e.message || String(e);
        if (errMsg.includes('权限') || errMsg.includes('permission') || errMsg.includes('admin')) {
            return `❌ 撤回失败：Bot 权限不足（可能是刚上任还没生效，或者对方是群主）`;
        }
        return `❌ 撤回异常：${errMsg}`;
    }
}

export default {
    name: "群管工具箱",
    description: "支持 撤回、群待办、取消待办、精华消息管理",

    match: function (text) {
        if (typeof text !== 'string') return false;
        const cmd = text.trim();
        // 支持带空格的指令，比如 "撤回 12345" 或 "撤回 喵~"
        return /^(撤回|群待办|取消待办|设置精华|加精|查看精华|看精华|移除精华|删精华|取消精华)/.test(cmd);
    },

    handle: async function (msg) {
        const text = (msg.pureText || "").trim();
        if (!text) return null;

        const chatId = msg.chatId || msg.group_id || msg.rawData?.group_id;
        const commandMsgId = msg.message_id || msg.messageId || msg.rawData?.message_id;
        const ws = msg._ws || globalThis.activeWs;

        // ==========================================
        // 🌟 核心优化：专注提取 引用ID
        // ==========================================
        let refId = null;
        
        // 1. 优先从标准数组中找
        if (Array.isArray(msg.message)) {
            const replyItem = msg.message.find(item => item?.type === 'reply');
            if (replyItem && replyItem.data) {
                refId = replyItem.data.id || replyItem.data.message_id;
            }
        }

        // 2. 从 content 或 text 的纯文本中找 (修复了这里的正则报错！)
        if (!refId) {
            const searchText = `${msg.content || ''} ${msg.raw_message || ''} ${text}`;
            // 同时兼容 [引用ID:123] 和 原生 [CQ:reply,id=123]
            const m = searchText.match(/\[引用ID:(-?\d+)\]/) || searchText.match(/\[CQ:reply,id=(-?\d+)\]/);
            if (m) refId = m[1];
        }

        // 3. 如果指令后面直接跟了数字
        if (!refId) {
            const cmdMatch = text.match(/\s+(-?\d+)$/);
            if (cmdMatch) refId = cmdMatch[1];
        }

        // 统一清洗一下 refId，只留数字和负号
        if (refId) {
            refId = String(refId).replace(/[^0-9-]/g, '');
        }

        // 获取主指令
        const mainCmd = text.split(/\s+/)[0];

        const isRecall = mainCmd === '撤回';
        const isTodo = mainCmd === '群待办';
        const isCancel = mainCmd === '取消待办';
        
        const isSetEssence = mainCmd === '设置精华' || mainCmd === '加精';
        const isGetEssence = mainCmd === '查看精华' || mainCmd === '看精华';
        const isDelEssence = mainCmd === '移除精华' || mainCmd === '删精华' || mainCmd === '取消精华';

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            if (!refId) return '⚠️ 未找到目标消息，请引用消息或附带消息ID使用。';
            const recallResult = await safeDeleteMessage(chatId, refId, ws);
            if (recallResult === true) {
                if (commandMsgId) {
                    await new Promise(r => setTimeout(r, 300));
                    await globalThis.wsCall('delete_msg', { message_id: String(commandMsgId) }, 3000, ws).catch(()=>{});
                }
                return null; 
            } else {
                return recallResult; 
            }
        }

        // ================= 2. 设置群待办 =================
        if (isTodo) {
            const isBotAdmin = await checkBotPermission(chatId, ws);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能设置群待办。';

            const targetMsgId = refId || commandMsgId;
            if (!targetMsgId) return '⚠️ 无法获取消息ID，请引用一条消息或直接发送指令';

            let success = false;
            let lastError = '';

            try {
                const result = await globalThis.wsCall('set_group_todo', {
                    group_id: Number(chatId),
                    message_id: String(targetMsgId) 
                }, 3000, ws); 
                if (isApiSuccess(result)) success = true;
                else lastError = result?.message || result?.msg;
            } catch (e) { lastError = e.message; }

            if (!success) {
                try {
                    const result = await globalThis.wsCall('_set_group_todo', {
                        group_id: Number(chatId),
                        message_id: String(targetMsgId) 
                    }, 3000, ws); 
                    if (isApiSuccess(result)) success = true;
                    else lastError = result?.message || result?.msg;
                } catch (e) {}
            }

            if (success) {
                db.prepare('INSERT OR REPLACE INTO group_todos (group_id, message_id) VALUES (?, ?)')
                  .run(String(chatId), String(targetMsgId));
                return '✅ 设置群待办成功';
            } else {
                if (String(lastError).includes('不支持') || String(lastError).includes('Not Found')) {
                    return '❌ 当前协议端不支持设置群待办，请检查协议端版本。';
                }
                return `❌ 设置群待办失败: ${lastError || '未知错误'}`;
            }
        }

        // ================= 3. 取消待办 =================
        if (isCancel) {
            const isBotAdmin = await checkBotPermission(chatId, ws);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能取消群待办。';

            try {
                const stmt = db.prepare('SELECT message_id FROM group_todos WHERE group_id = ?');
                const row = stmt.get(String(chatId));

                if (!row) return '✅ 当前群内没有本地记录的待办。';
                const messageId = row.message_id;

                let success = false;
                let lastError = '';

                try {
                    const result = await globalThis.wsCall('cancel_group_todo', {
                        group_id: Number(chatId),
                        message_id: String(messageId)
                    }, 3000, ws); 
                    if (isApiSuccess(result)) success = true;
                    else lastError = result?.message || result?.msg;
                } catch (e) { lastError = e.message; }

                if (!success) {
                    try {
                        const result = await globalThis.wsCall('_cancel_group_todo', {
                            group_id: Number(chatId),
                            message_id: String(messageId)
                        }, 3000, ws); 
                        if (isApiSuccess(result)) success = true;
                        else lastError = result?.message || result?.msg;
                    } catch (e) {}
                }

                db.prepare('DELETE FROM group_todos WHERE group_id = ?').run(String(chatId));

                if (success) return '✅ 取消待办成功';
                else {
                    if (String(lastError).includes('不存在') || String(lastError).includes('缺少参数') || String(lastError).includes('Not Found')) {
                        return '✅ 群待办已失效或被手动取消，本地记录已清理。';
                    }
                    if (String(lastError).includes('不支持')) {
                        return '⚠️ 当前协议端不支持取消待办功能，本地记录已清理。';
                    }
                    return `⚠️ 取消失败，但已清理本地记录。(原因: ${lastError || '未知'})`;
                }
            } catch (e) {
                return `❌ 取消待办时异常: ${e.message}`;
            }
        }

        // ================= 4. 设置精华 =================
        if (isSetEssence) {
            const isBotAdmin = await checkBotPermission(chatId, ws);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能设置精华。';

            const targetMsgId = refId || commandMsgId; 
            if (!targetMsgId) return '⚠️ 无法获取消息ID，请引用一条消息或直接发送指令';

            try {
                const result = await globalThis.wsCall('set_essence_msg', {
                    group_id: Number(chatId),
                    message_id: String(targetMsgId)
                }, 3000, ws); 
                if (isApiSuccess(result)) {
                    return '✅ 设置精华消息成功！';
                }
                return `❌ 设置精华失败：${result?.msg || result?.message || '可能是消息已被撤回或不存在'}`;
            } catch (e) {
                return `❌ 设置精华异常: ${e.message}`;
            }
        }

        // ================= 5. 查看精华 =================
        if (isGetEssence) {
            try {
                const result = await globalThis.wsCall('get_essence_msg_list', {
                    group_id: Number(chatId)
                }, 3000, ws); 
                
                if (!isApiSuccess(result)) {
                    return `❌ 获取精华列表失败：${result?.msg || '接口异常'}`;
                }

                const list = result?.data || (Array.isArray(result) ? result : []);
                if (!Array.isArray(list) || list.length === 0) return '📭 本群暂无精华消息。';

                let reply = `📜 本群精华消息列表 (共 ${list.length} 条，仅展示前10条)：\n\n`;
                const displayList = list.slice(0, 10);
                
                displayList.forEach((item, index) => {
                    const msgId = item.message_id || item.msg_id || '未知ID';
                    const sender = item.sender_nick || item.sender_id || '未知';
                    let content = item.content || '';
                    
                    if (typeof content !== 'string') content = JSON.stringify(content);
                    content = content.replace(/\[CQ:[^\]]+\]/g, '[富文本]').substring(0, 30);
                    if (content.length >= 30) content += '...';

                    reply += `${index + 1}. [ID:${msgId}] ${sender}：${content || '[图片/文件等]'}\n`;
                });
                
                if (list.length > 10) reply += `\n... 剩余 ${list.length - 10} 条请使用群应用查看`;
                return reply.trim();
            } catch (e) {
                return `❌ 查看精华异常: ${e.message}`;
            }
        }

        // ================= 6. 移除精华 =================
        if (isDelEssence) {
            const isBotAdmin = await checkBotPermission(chatId, ws);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能移除精华。';

            const targetMsgId = refId;
            if (!targetMsgId) return '⚠️ 请引用需要移除精华的消息后再发送此指令。';

            try {
                const result = await globalThis.wsCall('delete_essence_msg', {
                    group_id: Number(chatId),
                    message_id: String(targetMsgId)
                }, 3000, ws); 
                if (isApiSuccess(result)) {
                    return '✅ 移除精华消息成功！';
                }
                return `❌ 移除精华失败：${result?.msg || result?.message || '可能是该消息不在精华列表中'}`;
            } catch (e) {
                return `❌ 移除精华异常: ${e.message}`;
            }
        }
    }
};