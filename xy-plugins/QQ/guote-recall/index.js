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
    description: "支持 #撤回、#群待办、#取消待办",

    // app.js 现在只传入纯文本，这里直接判断字符串
    match: function (text) {
        if (typeof text !== 'string') return false;
        return /#撤回|#群待办|#取消待办/i.test(text);
    },

    handle: async function (msg, matchResult) {
        // 🌟 核心修复 1：msg.text 是数组，必须用 msg.pureText 拿纯文本
        let text = msg.pureText || msg.content || "";
        const chatId = msg.chatId || msg.group_id;
        const commandMsgId = msg.message_id || msg.messageId;

        // 提取引用ID（用 msg.content 匹配，因为它包含 [引用ID:xxx]）
        let m = (msg.content || "").match(/\[引用ID:(-?\d+)\]/);
        let refId = m ? parseInt(m[1]) : null;

        const isRecall = text.includes('#撤回');
        const isTodo = text.includes('#群待办');
        const isCancel = text.includes('#取消待办');

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            if (!refId) return '⚠️ 未找到引用ID，请回复需要撤回的消息后使用';

            try {
                // 撤回引用的消息
                await fetch('http://127.0.0.1:3000/delete_msg', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message_id: refId })
                });
                // 延迟一下，把指令本身也撤回了（保持群聊干净）
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

            // 🌟 修复 2：待办通常是置顶引用的消息，如果没引用就把指令消息置顶
            const targetMsgId = refId || commandMsgId;
            if (!targetMsgId) return '⚠️ 无法获取消息ID，请引用一条消息或直接发送本指令';

            async function tryTodo(actionName) {
                const res = await fetch(`http://127.0.0.1:3000/${actionName}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        group_id: Number(chatId),
                        message_id: Number(targetMsgId)
                    })
                });
                return res.json();
            }

            try {
                console.log('[INFO] 尝试调用标准 set_group_todo...');
                let result = await tryTodo('set_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    // 🌟 修复 3：成功设置后，必须把 message_id 存进数据库！
                    db.prepare('INSERT OR REPLACE INTO group_todos (group_id, message_id) VALUES (?, ?)')
                      .run(String(chatId), String(targetMsgId));
                    return '✅ 设置群待办成功 (标准接口)' ;
                }

                console.log('[INFO] 标准接口失败，尝试调用 _set_group_todo...');
                result = await tryTodo('_set_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    // 存库
                    db.prepare('INSERT OR REPLACE INTO group_todos (group_id, message_id) VALUES (?, ?)')
                      .run(String(chatId), String(targetMsgId));
                    return '✅ 设置群待办成功 (兼容接口)' ;
                }

                throw new Error(result.message || '未知错误');

            } catch (e) {
                console.error('[ERROR] 设置群待办失败:', e);
                return `❌ 设置群待办失败: ${e.message}\n可能原因：协议端版本过低或不支持此操作` ;
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
                    const res = await fetch(`http://127.0.0.1:3000/${actionName}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            group_id: Number(chatId),
                            message_id: Number(messageId)
                        })
                    });
                    return res.json();
                }

                console.log('[INFO] 尝试调用标准 cancel_group_todo...');
                let result = await tryCancel('cancel_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    // 删库
                    db.prepare('DELETE FROM group_todos WHERE group_id = ?').run(String(chatId));
                    return '✅ 取消待办成功 (标准接口)';
                }

                console.log('[INFO] 标准接口失败，尝试调用 _cancel_group_todo...');
                result = await tryCancel('_cancel_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    db.prepare('DELETE FROM group_todos WHERE group_id = ?').run(String(chatId));
                    return '✅ 取消待办成功 (兼容接口)';
                }

                throw new Error(result.message || result.msg || '未知错误');

            } catch (e) {
                return `❌ 取消待办时异常: ${e.message}`;
            }
        }
    }
};