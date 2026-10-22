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

// 🌟 提取公共检查函数，使用 wsCall
async function checkBotPermission(chatId) {
    if (typeof globalThis.wsCall !== 'function') return '❌ 框架底层未就绪 (wsCall 缺失)';
    try {
        const botData = await globalThis.wsCall('get_login_info');
        const botQQ = botData?.data?.user_id;
        if (!botQQ) return '❌ 无法获取 Bot 账号信息';

        const info = await globalThis.wsCall('get_group_member_info', {
            group_id: Number(chatId),
            user_id: Number(botQQ),
            no_cache: true
        });
        
        const role = info?.data?.role;
        if (role !== 'owner' && role !== 'admin') {
            return '❌ Bot权限不足：请先将 Bot 设为群管理员或群主';
        }
        return true;
    } catch (e) {
        return `❌ 权限校验异常：${e.message}`;
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

        // 从标准 content 中提取引用 ID
        let m = (msg.content || "").match(/\[引用ID:(-?\d+)\]/);
        let refId = m ? parseInt(m[1]) : null;

        const isRecall = text === '撤回';
        const isTodo = text === '群待办';
        const isCancel = text === '取消待办';

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            if (!refId) return '⚠️ 未找到引用ID，请回复需要撤回的消息后使用 #撤回';
            if (typeof globalThis.wsCall !== 'function') return '❌ 框架底层未就绪';

            // 🌟 核心新增：撤回前先检查 Bot 是否有管理员权限
            const checkResult = await checkBotPermission(chatId);
            if (checkResult !== true) return checkResult;

            try {
                // 撤回引用的消息
                await globalThis.wsCall('delete_msg', { message_id: refId });
                
                // 撤回指令本身
                if (commandMsgId) {
                    await new Promise(r => setTimeout(r, 300));
                    await globalThis.wsCall('delete_msg', { message_id: commandMsgId });
                }
                return null; // 撤回成功不需要发提示
            } catch (err) {
                return `❌ 撤回失败: ${err.message}`;
            }
        }

        // ================= 2. 设置群待办 =================
        if (isTodo) {
            const checkResult = await checkBotPermission(chatId);
            if (checkResult !== true) return checkResult;

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
            const checkResult = await checkBotPermission(chatId);
            if (checkResult !== true) return checkResult;

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