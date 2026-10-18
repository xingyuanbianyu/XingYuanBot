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

console.log('✅ 数据库初始化完成 (ESM模式)');

export default {
    name: "群管工具箱",
    description: "支持 撤回、群待办、取消待办",

    match: function (text) {
        if (typeof text !== 'string') return false;
        return /撤回|群待办|取消待办/i.test(text);
    },

    handle: async function (msg, matchResult) {
        let text = (msg.pureText || "").trim();
        if (!text) return null;

        const chatId = msg.chatId || msg.group_id;
        const commandMsgId = msg.message_id || msg.messageId;

        let m = (msg.content || "").match(/\[引用ID:(-?\d+)\]/);
        let refId = m ? parseInt(m[1]) : null;

        const isRecall = text === '撤回';
        const isTodo = text === '群待办';
        const isCancel = text === '取消待办';

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            if (!refId) return '⚠️ 未找到引用ID，请回复需要撤回的消息后使用';

            try {
                await fetch('http://127.0.0.1:3000/delete_msg', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message_id: refId })
                });
                if (commandMsgId) {
                    await new Promise(r => setTimeout(r, 300));
                    await fetch('http://127.0.0.1:3000/delete_msg', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message_id: commandMsgId })
                    });
                }
                return null; 
            } catch (err) {
                return `❌ 撤回失败: ${err.message}`;
            }
        }

        // ================= 权限检查 =================
        async function checkBotPermission() {
            try {
                const botRes = await fetch('http://127.0.0.1:3000/get_login_info');
                const botData = await botRes.json();
                const botQQ = botData?.data?.user_id;
                if (!botQQ) return '❌ 无法获取 Bot 账号信息';

                const infoRes = await fetch(`http://127.0.0.1:3000/get_group_member_info?group_id=${chatId}&user_id=${botQQ}&no_cache=true`);
                const info = await infoRes.json();
                const role = info?.data?.role;
                if (role !== 'owner' && role !== 'admin') {
                    return '❌ Bot权限不足：请先将 Bot 设为群管理员或群主';
                }
                return true;
            } catch (e) {
                return `❌ 权限校验异常：${e.message}`;
            }
        }

        // ================= 2. 设置群待办 =================
        if (isTodo) {
            const checkResult = await checkBotPermission();
            if (checkResult !== true) return checkResult;

            const targetMsgId = refId || commandMsgId;
            if (!targetMsgId) return '⚠️ 无法获取消息ID，请引用一条消息或直接发送本指令';

            async function tryTodo(actionName) {
                try {
                    const res = await fetch(`http://127.0.0.1:3000/${actionName}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            group_id: Number(chatId),
                            message_id: String(targetMsgId) 
                        })
                    });
                    return await res.json();
                } catch (e) {
                    return { status: 'failed', message: e.message };
                }
            }

            let success = false;
            let lastError = '';

            let result = await tryTodo('set_group_todo');
            if (result.status === 'ok' || result.retcode === 0) {
                success = true;
            } else {
                lastError = result.message || result.msg;
                result = await tryTodo('_set_group_todo');
                if (result.status === 'ok' || result.retcode === 0) {
                    success = true;
                }
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
            const checkResult = await checkBotPermission();
            if (checkResult !== true) return checkResult;

            try {
                const stmt = db.prepare('SELECT message_id FROM group_todos WHERE group_id = ?');
                const row = stmt.get(String(chatId));

                if (!row) {
                    return '✅ 当前群内没有本地记录的待办。';
                }

                const messageId = row.message_id;

                async function tryCancel(actionName) {
                    try {
                        const res = await fetch(`http://127.0.0.1:3000/${actionName}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                group_id: Number(chatId),
                                message_id: String(messageId) // 🌟 恢复传入 message_id
                            })
                        });
                        return await res.json();
                    } catch (e) {
                        return { status: 'failed', message: e.message };
                    }
                }

                let success = false;
                let lastError = '';

                let result = await tryCancel('cancel_group_todo');
                if (result.status === 'ok' || result.retcode === 0) {
                    success = true;
                } else {
                    lastError = result.message || result.msg;
                    result = await tryCancel('_cancel_group_todo');
                    if (result.status === 'ok' || result.retcode === 0) {
                        success = true;
                    }
                }

                // 无论成功还是失败，只要触发了取消逻辑，本地记录直接清空
                db.prepare('DELETE FROM group_todos WHERE group_id = ?').run(String(chatId));

                if (success) {
                    return '✅ 取消待办成功';
                } else {
                    // 🌟 截图中反映出来的“缺少参数”或“不存在”，全都视为失效并清理
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