import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = `${__dirname}/todo.db`;

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

// 🌟 辅助函数：检查 Bot 在该群的权限
async function checkBotPermission(chatId) {
    if (typeof globalThis.wsCall !== 'function') return false;
    try {
        const botData = await globalThis.wsCall('get_login_info');
        const botQQ = botData?.data?.user_id;
        if (!botQQ) return false;

        const info = await globalThis.wsCall('get_group_member_info', {
            group_id: Number(chatId),
            user_id: Number(botQQ),
            no_cache: true
        });
        
        const role = info?.data?.role;
        return role === 'owner' || role === 'admin';
    } catch (e) {
        return false;
    }
}

// 🌟 核心新增：智能安全撤回函数
async function safeDeleteMessage(chatId, messageId) {
    if (typeof globalThis.wsCall !== 'function') return '❌ 框架底层未就绪';
    
    // 1. 获取被撤回的消息信息，判断是不是自己发的
    let isBotMessage = false;
    try {
        const msgInfo = await globalThis.wsCall('get_msg', { message_id: Number(messageId) });
        const senderId = msgInfo?.data?.sender?.user_id || msgInfo?.data?.user_id;
        if (String(senderId) === String(globalThis.botInfo?.qq)) {
            isBotMessage = true;
        }
    } catch(e) {}

    // 2. 检查 Bot 权限
    const isBotAdmin = await checkBotPermission(chatId);

    // 3. 判定：不是管理员，且撤回的不是自己的消息 -> 拒绝
    if (!isBotAdmin && !isBotMessage) {
        return '❌ Bot权限不足：非管理员只能撤回自己发送的消息';
    }

    // 4. 执行撤回
    try {
        const result = await globalThis.wsCall('delete_msg', { message_id: Number(messageId) });
        if (result && (result.status === 'ok' || result.retcode === 0)) return true;
        return `❌ 撤回失败：${result?.msg || result?.message || '未知错误'}`;
    } catch (e) {
        return `❌ 撤回异常：${e.message}`;
    }
}

export default {
    name: "群管工具箱",
    description: "支持 撤回、群待办、取消待办",

    match: function (text) {
        if (typeof text !== 'string') return false;
        return /撤回|群待办|取消待办/i.test(text);
    },

    handle: async function (msg, matchResult) {
        // 剥离 # 或 / 前缀
        let text = (msg.pureText || "").trim().replace(/^[#\/]+/, '').trim();
        if (!text) return null;

        const chatId = msg.chatId || msg.group_id || msg.rawData?.group_id;
        const commandMsgId = msg.message_id || msg.messageId || msg.rawData?.message_id;

        // 🌟 核心修复：多源提取引用 ID
        let refId = null;
        
        // 方式1：从标准 message 数组提取（兼容很多现代协议端）
        if (Array.isArray(msg.message)) {
            const replyItem = msg.message.find(item => item?.type === 'reply');
            if (replyItem && replyItem.data) {
                refId = replyItem.data.id || replyItem.data.message_id;
            }
        }
        
        // 方式2：从 content 正则提取（兜底老版本）
        if (!refId) {
            let m = (msg.content || "").match(/\[引用ID:(-?\d+)\]/);
            if (m) refId = m[1];
        }

        const isRecall = text === '撤回';
        const isTodo = text === '群待办';
        const isCancel = text === '取消待办';

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            if (!refId) return '⚠️ 未找到引用消息，请引用需要撤回的消息后使用 撤回';

            // 使用智能撤回
            const recallResult = await safeDeleteMessage(chatId, refId);
            
            if (recallResult === true) {
                // 如果撤回成功，顺便把用户发的这条“撤回”指令也删了
                if (commandMsgId) {
                    await new Promise(r => setTimeout(r, 300));
                    await globalThis.wsCall('delete_msg', { message_id: commandMsgId });
                }
                return null; // 撤回成功不需要发文字提示
            } else {
                return recallResult; // 撤回失败返回错误原因
            }
        }

        // ================= 2. 设置群待办 =================
        if (isTodo) {
            const isBotAdmin = await checkBotPermission(chatId);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能设置群待办。';

            const targetMsgId = refId || commandMsgId;
            if (!targetMsgId) return '⚠️ 无法获取消息ID，请引用一条消息或直接发送指令';

            let success = false;
            let lastError = '';

            // 尝试标准 API
            try {
                const result = await globalThis.wsCall('set_group_todo', {
                    group_id: Number(chatId),
                    message_id: String(targetMsgId) 
                });
                if (result.status === 'ok' || result.retcode === 0) success = true;
                else lastError = result.message || result.msg;
            } catch (e) {
                lastError = e.message;
            }

            // 尝试备用 API (部分协议端兼容)
            if (!success) {
                try {
                    const result = await globalThis.wsCall('_set_group_todo', {
                        group_id: Number(chatId),
                        message_id: String(targetMsgId) 
                    });
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
            const isBotAdmin = await checkBotPermission(chatId);
            if (!isBotAdmin) return '❌ Bot权限不足：需设为管理员才能取消群待办。';

            try {
                const stmt = db.prepare('SELECT message_id FROM group_todos WHERE group_id = ?');
                const row = stmt.get(String(chatId));

                if (!row) {
                    return '✅ 当前群内没有本地记录的待办。';
                }

                const messageId = row.message_id;

                let success = false;
                let lastError = '';

                // 尝试标准 API
                try {
                    const result = await globalThis.wsCall('cancel_group_todo', {
                        group_id: Number(chatId),
                        message_id: String(messageId)
                    });
                    if (result.status === 'ok' || result.retcode === 0) success = true;
                    else lastError = result.message || result.msg;
                } catch (e) {
                    lastError = e.message;
                }

                // 尝试备用 API
                if (!success) {
                    try {
                        const result = await globalThis.wsCall('_cancel_group_todo', {
                            group_id: Number(chatId),
                            message_id: String(messageId)
                        });
                        if (result.status === 'ok' || result.retcode === 0) success = true;
                        else lastError = result.message || result.msg;
                    } catch (e) {}
                }

                // 清空记录
                db.prepare('DELETE FROM group_todos WHERE group_id = ?').run(String(chatId));

                if (success) {
                    return '✅ 取消待办成功';
                } else {
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
    }
};