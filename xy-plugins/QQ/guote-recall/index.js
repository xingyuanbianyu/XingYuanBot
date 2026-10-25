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

// 🌟 优化 1：Bot 权限缓存，减少 API 调用
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
        const botQQ = botData?.data?.user_id;
        if (!botQQ) return false;

        const info = await globalThis.wsCall('get_group_member_info', {
            group_id: Number(chatId),
            user_id: Number(botQQ),
            no_cache: true
        }, 3000, ws);
        
        const role = info?.data?.role;
        const hasPerm = role === 'owner' || role === 'admin';
        botPermCache.set(gid, { hasPerm, time: Date.now() });
        return hasPerm;
    } catch (e) {
        return false;
    }
}

// 智能安全撤回函数 (加入 ws 传递)
async function safeDeleteMessage(chatId, messageId, ws) {
    if (typeof globalThis.wsCall !== 'function') return '❌ 框架底层未就绪';
    
    let isBotMessage = false;
    try {
        const msgInfo = await globalThis.wsCall('get_msg', { message_id: Number(messageId) }, 3000, ws);
        const senderId = msgInfo?.data?.sender?.user_id || msgInfo?.data?.user_id;
        if (String(senderId) === String(globalThis.botInfo?.qq)) {
            isBotMessage = true;
        }
    } catch(e) {}

    const isBotAdmin = await checkBotPermission(chatId, ws);

    if (!isBotAdmin && !isBotMessage) {
        return '❌ Bot权限不足：非管理员只能撤回自己发送的消息';
    }

    try {
        const result = await globalThis.wsCall('delete_msg', { message_id: Number(messageId) }, 3000, ws);
        if (result && (result.status === 'ok' || result.retcode === 0)) return true;
        return `❌ 撤回失败：${result?.msg || result?.message || '未知错误'}`;
    } catch (e) {
        return `❌ 撤回异常：${e.message}`;
    }
}

export default {
    name: "群管工具箱",
    description: "支持 撤回、群待办、取消待办、精华消息管理",

    // 严格匹配指令
    match: function (text) {
        if (typeof text !== 'string') return false;
        const cmd = text.trim();
        return /^(撤回|群待办|取消待办|设置精华|加精|查看精华|看精华|移除精华|删精华|取消精华)$/.test(cmd);
    },

    handle: async function (msg) {
        const text = (msg.pureText || "").trim();
        if (!text) return null;

        const chatId = msg.chatId || msg.group_id || msg.rawData?.group_id;
        const commandMsgId = msg.message_id || msg.messageId || msg.rawData?.message_id;
        const ws = msg._ws;

        // 多源提取引用 ID
        let refId = null;
        if (Array.isArray(msg.message)) {
            const replyItem = msg.message.find(item => item?.type === 'reply');
            if (replyItem && replyItem.data) {
                refId = replyItem.data.id || replyItem.data.message_id;
            }
        }
        if (!refId) {
            let m = (msg.content || "").match(/\[引用ID:(-?\d+)\]/);
            if (m) refId = m[1];
        }

        const isRecall = text === '撤回';
        const isTodo = text === '群待办';
        const isCancel = text === '取消待办';
        
        const isSetEssence = text === '设置精华' || text === '加精';
        const isGetEssence = text === '查看精华' || text === '看精华';
        const isDelEssence = text === '移除精华' || text === '删精华' || text === '取消精华';

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            if (!refId) return '⚠️ 未找到引用消息，请引用需要撤回的消息后使用 撤回';
            const recallResult = await safeDeleteMessage(chatId, refId, ws);
            if (recallResult === true) {
                if (commandMsgId) {
                    await new Promise(r => setTimeout(r, 300));
                    await globalThis.wsCall('delete_msg', { message_id: commandMsgId }, 3000, ws);
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
                if (result.status === 'ok' || result.retcode === 0) success = true;
                else lastError = result.message || result.msg;
            } catch (e) { lastError = e.message; }

            if (!success) {
                try {
                    const result = await globalThis.wsCall('_set_group_todo', {
                        group_id: Number(chatId),
                        message_id: String(targetMsgId) 
                    }, 3000, ws); 
                    if (result.status === 'ok' || result.retcode === 0) success = true;
                    else lastError = result.message || result.msg;
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
                    if (result.status === 'ok' || result.retcode === 0) success = true;
                    else lastError = result.message || result.msg;
                } catch (e) { lastError = e.message; }

                if (!success) {
                    try {
                        const result = await globalThis.wsCall('_cancel_group_todo', {
                            group_id: Number(chatId),
                            message_id: String(messageId)
                        }, 3000, ws); 
                        if (result.status === 'ok' || result.retcode === 0) success = true;
                        else lastError = result.message || result.msg;
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

        // ================= 4. 设置精华 (所有人可用，Bot需权限) =================
        if (isSetEssence) {
            // 🌟 核心修正：不再校验发指令的人，只校验 Bot 是否有权限
            const isBotAdmin = await checkBotPermission(chatId, ws);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能设置精华。';

            const targetMsgId = refId || commandMsgId; 
            if (!targetMsgId) return '⚠️ 无法获取消息ID，请引用一条消息或直接发送指令';

            try {
                const result = await globalThis.wsCall('set_essence_msg', {
                    group_id: Number(chatId),
                    message_id: Number(targetMsgId)
                }, 3000, ws); 
                if (result && (result.status === 'ok' || result.retcode === 0)) {
                    return '✅ 设置精华消息成功！';
                }
                return `❌ 设置精华失败：${result?.msg || result?.message || '可能是消息已被撤回或不存在'}`;
            } catch (e) {
                return `❌ 设置精华异常: ${e.message}`;
            }
        }

        // ================= 5. 查看精华 (所有人可用) =================
        if (isGetEssence) {
            try {
                const result = await globalThis.wsCall('get_essence_msg_list', {
                    group_id: Number(chatId)
                }, 3000, ws); 
                
                if (!result || (result.status !== 'ok' && result.retcode !== 0)) {
                    return `❌ 获取精华列表失败：${result?.msg || '接口异常'}`;
                }

                const list = result.data || [];
                if (list.length === 0) return '📭 本群暂无精华消息。';

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

        // ================= 6. 移除精华 (所有人可用，Bot需权限) =================
        if (isDelEssence) {
            // 🌟 核心修正：同样只校验 Bot 权限
            const isBotAdmin = await checkBotPermission(chatId, ws);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能移除精华。';

            const targetMsgId = refId;
            if (!targetMsgId) return '⚠️ 请引用需要移除精华的消息后再发送此指令。';

            try {
                const result = await globalThis.wsCall('delete_essence_msg', {
                    group_id: Number(chatId),
                    message_id: Number(targetMsgId)
                }, 3000, ws); 
                if (result && (result.status === 'ok' || result.retcode === 0)) {
                    return '✅ 移除精华消息成功！';
                }
                return `❌ 移除精华失败：${result?.msg || result?.message || '可能是该消息不在精华列表中'}`;
            } catch (e) {
                return `❌ 移除精华异常: ${e.message}`;
            }
        }
    }
};