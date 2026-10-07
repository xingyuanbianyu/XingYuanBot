// ✅ 修改点：使用 import 替代 require
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

// 获取当前文件所在目录（用于确保数据库文件路径正确）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = `${__dirname}/todo.db`;

// 初始化数据库
const db = new Database(dbPath); 
db.pragma('journal_mode = WAL'); // 开启高性能模式

// 建表逻辑
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

    match: function (text, msg) {
        let txt = "";
        if (typeof text === "string") txt = text;
        else if (Array.isArray(text)) {
            for (let s of text) {
                if (s && s.type === "text") txt += (s.data && s.data.text ? s.data.text : "");
            }
        }
        return /#撤回|#群待办|#取消待办/i.test(txt);
    },

    handle: async function (msg, matchResult) {
        let text = msg.text || "";
        const chatId = msg.chatId || msg.group_id;
        const commandMsgId = msg.messageId;

        // 提取引用ID
        let m = text.match(/\[引用ID:(-?\d+)\]/);
        let refId = m ? parseInt(m[1]) : null;

        const isRecall = text.includes('#撤回');
        const isTodo = text.includes('#群待办');
        const isCancel = text.includes('#取消待办');

        // ================= 1. 撤回逻辑 =================
        if (isRecall) {
            console.log('[撤回] 开始执行');
            if (!m) return '⚠️ 未找到引用ID，请回复消息后使用';

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

        if (isTodo) {
            const checkResult = await checkBotPermission();
            if (!checkResult === true) {
                return checkResult;
            }

            const refId = msg.message_id;

            // 定义一个通用的请求函数，方便重试
            async function tryTodo(actionName) {
                const res = await fetch(`http://127.0.0.1:3000/${actionName}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        group_id: Number(chatId),
                        message_id: Number(refId)
                    })
                });
                return res.json();
            }

            try {
                // 1. 优先尝试标准接口 (NapCat / 新版 LLOneBot)
                console.log('[INFO] 尝试调用标准 set_group_todo...');
                let result = await tryTodo('set_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    return '✅ 设置群待办成功 (标准接口)' ;
                }

                // 2. 如果标准接口失败，尝试带下划线的接口 (部分 LLOneBot 版本)
                console.log('[INFO] 标准接口失败，尝试调用 _set_group_todo...');
                result = await tryTodo('_set_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    return '✅ 设置群待办成功 (兼容接口)' ;
                }

                // 3. 如果都失败，抛出错误进入 catch
                throw new Error(result.message || '未知错误');

            } catch (e) {
                // 最终失败处理
                console.error('[ERROR] 设置群待办失败:', e);
                return `❌ 设置群待办失败: ${e.message}\n可能原因：协议端版本过低或不支持此操作` ;
            }
            return false;
        }

        // ================= 3. 取消待办逻辑 (读取数据库) =================
        if (isCancel) {
            console.log('[取消待办] 开始执行...');
            const checkResult = await checkBotPermission();
            if (checkResult !== true) return checkResult;

            try {
                // ✅ 关键：直接从本地数据库查 ID，不依赖 NapCat 接口
                const stmt = db.prepare('SELECT message_id FROM group_todos WHERE group_id = ?');
                const row = stmt.get(String(chatId));

                if (!row) {
                    return '✅ 当前群内没有本地记录的待办。';
                }

                const messageId = row.message_id;

                // 定义一个通用的请求函数，方便重试
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

                // 1. 优先尝试标准接口 (NapCat / 新版 LLOneBot)
                console.log('[INFO] 尝试调用标准 cancel_group_todo...');
                let result = await tryCancel('cancel_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    // 取消成功后，删除本地记录
                    const delStmt = db.prepare('DELETE FROM group_todos WHERE group_id = ?');
                    delStmt.run(String(chatId));
                    return '✅ 取消待办成功 (标准接口)';
                }

                // 2. 如果标准接口失败，尝试带下划线的接口 (部分 LLOneBot 版本)
                console.log('[INFO] 标准接口失败，尝试调用 _cancel_group_todo...');
                result = await tryCancel('_cancel_group_todo');

                if (result.status === 'ok' || result.retcode === 0) {
                    // 取消成功后，删除本地记录
                    const delStmt = db.prepare('DELETE FROM group_todos WHERE group_id = ?');
                    delStmt.run(String(chatId));
                    return '✅ 取消待办成功 (兼容接口)';
                }

                // 如果都失败，抛出错误进入 catch
                throw new Error(result.message || result.msg || '未知错误');

            } catch (e) {
                return `❌ 取消待办时异常: ${e.message}`;
            }
        }
    }
};