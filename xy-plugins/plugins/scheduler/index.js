import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const DB_PATH = path.join(__dirname, 'scheduler.db');

// 初始化数据库
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduler_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    trigger_time TEXT NOT NULL,
    command TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    last_run_date TEXT,
    is_loop INTEGER DEFAULT 0
  )
`);

// 兼容旧表，增加 is_loop 字段
try { db.exec(`ALTER TABLE scheduler_tasks ADD COLUMN is_loop INTEGER DEFAULT 0`); } catch (e) {}

let tickCount = 0;

// ================= 核心轮询器 =================
setInterval(async () => {
    try {
        const config = (() => {
            try { return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) { return {}; }
        })();
        if (config.enabled === false) return;

        tickCount++;
        if (tickCount % 6 === 0) {
            const count = db.prepare('SELECT COUNT(*) as c FROM scheduler_tasks').get().c;
            globalThis.print(`[定时调度] 轮询器运行中... 共 ${count} 个任务`);
        }

        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        
        const tasks = db.prepare('SELECT * FROM scheduler_tasks').all();
        if (tasks.length === 0) return;

        for (const task of tasks) {
            // 如果今天已经跑过了（不管是循环还是单次，只要跑过就跳过）
            if (task.last_run_date === todayStr) continue;

            const [th, tm] = task.trigger_time.split(':').map(Number);
            const taskDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), th, tm, 0);
            
            const diffMs = now.getTime() - taskDate.getTime();
            const diffMinutes = diffMs / (1000 * 60);

            // 过了时间且在 3 小时内就触发
            if (diffMinutes >= 0 && diffMinutes <= 180) {
                
                if (!globalThis._ws || globalThis._ws.readyState !== 1) {
                    globalThis.print(`[定时调度] ⏳ 准备触发，但 WS 未连接，等待 10 秒后重试...`);
                    continue; 
                }

                globalThis.print(`\n========================================`);
                globalThis.print(`[定时调度] 🎯 触发任务! 群:${task.group_id} 指令:${task.command} (循环:${task.is_loop === 1 ? '开' : '关'})`);
                globalThis.print(`========================================\n`);
                
                let userRole = 'member';
                let userNick = '定时任务';
                
                try {
                    const memberRes = await fetch(`http://127.0.0.1:3000/get_group_member_info?group_id=${task.group_id}&user_id=${task.creator_id}`);
                    const memberData = await memberRes.json();
                    if (memberData && memberData.data) {
                        if (memberData.data.role) userRole = memberData.data.role; 
                        if (memberData.data.card || memberData.data.nickname) {
                            userNick = memberData.data.card || memberData.data.nickname;
                        }
                    }
                } catch (e) {}

                const fakeMsgData = {
                    time: Math.floor(Date.now() / 1000),
                    self_id: Number(globalThis.botInfo?.qq || 10000), 
                    post_type: "message",
                    message_type: "group",
                    sub_type: "normal",
                    message_id: Math.floor(Math.random() * 10000000),
                    group_id: Number(task.group_id),
                    user_id: Number(task.creator_id),
                    raw_message: task.command,
                    font: 0,
                    sender: { 
                        user_id: Number(task.creator_id), 
                        nickname: userNick, 
                        card: userNick,
                        role: userRole 
                    },
                    message: [{ type: 'text', data: { text: task.command } }]
                };

                if (typeof globalThis.handleIncomingMessage === 'function') {
                    globalThis.print(`[定时调度] 🚀 正在注入伪消息给框架...`);
                    try {
                        globalThis.handleIncomingMessage(JSON.stringify(fakeMsgData), globalThis._ws, globalThis._registry, globalThis._plugins);
                        
                        // 🌟 执行后处理：
                        if (task.is_loop === 1) {
                            // 循环任务：更新最后执行时间，明天继续
                            db.prepare('UPDATE scheduler_tasks SET last_run_date = ? WHERE id = ?').run(todayStr, task.id);
                            globalThis.print(`[定时调度] ✅ 注入完成 (循环任务已保留)`);
                        } else {
                            // 单次任务：直接删除
                            db.prepare('DELETE FROM scheduler_tasks WHERE id = ?').run(task.id);
                            globalThis.print(`[定时调度] ✅ 注入完成 (单次任务已自动销毁)`);
                        }
                        
                    } catch (e) {
                        globalThis.print(`[定时调度] ❌ 注入伪消息失败: ${e.message}`);
                    }
                } else {
                    globalThis.print(`[定时调度] ❌ 致命错误: 找不到 handleIncomingMessage 回调!`);
                }
            }
        }
    } catch (err) {
        globalThis.print(`[定时调度] 💥 轮询异常: ${err.message}`);
    }
}, 10000);


export default {
    name: '定时调度',

    match(text) {
        if (typeof text !== 'string') return false;
        return text.startsWith('添加定时') || text.startsWith('查看定时') || text.startsWith('删除定时');
    },

    async handle(msg) {
        const pureText = (msg.pureText || "").trim();
        const chatId = msg.chatId;
        const senderQQ = msg.senderQQ;

        // ================= 添加定时 =================
        if (pureText.startsWith('添加定时')) {
            // 🌟 正则更新：支持末尾带参数
            const match = pureText.match(/^添加定时\s+(\d{1,2}:\d{1,2})\s*(?:\/|\s)\s*(.+)$/);
            if (!match) return '⚠️ 格式错误！\n用法：#添加定时 08:30 / #打卡 [开/关]';

            let timeStr = match[1];
            let rest = match[2].trim();
            let isLoop = 0; // 默认关

            // 解析末尾开关：开、循环、关、一次
            const loopMatch = rest.match(/(.+?)\s+(开|循环|关|一次)$/);
            if (loopMatch) {
                const mode = loopMatch[2];
                if (mode === '开' || mode === '循环') isLoop = 1;
                rest = loopMatch[1].trim(); // 提取出真正的指令
            }

            const [h, m] = timeStr.split(':');
            timeStr = `${String(parseInt(h)).padStart(2, '0')}:${String(parseInt(m)).padStart(2, '0')}`;

            db.prepare('INSERT INTO scheduler_tasks (group_id, trigger_time, command, creator_id, is_loop) VALUES (?, ?, ?, ?, ?)')
              .run(String(chatId), timeStr, rest, String(senderQQ), isLoop);

            const loopStatus = isLoop === 1 ? '开 (每天循环)' : '关 (只执行一次)';
            return `✅ 定时任务添加成功！\n⏱️ 触发时间：每天 ${timeStr}\n📝 触发指令：${rest}\n🔄 循环开关：${loopStatus}`;
        }

        // ================= 查看定时 =================
        if (pureText.startsWith('查看定时')) {
            const tasks = db.prepare('SELECT * FROM scheduler_tasks WHERE group_id = ?').all(String(chatId));
            if (!tasks || tasks.length === 0) return '📭 当前群没有设置任何定时任务。';
            
            let reply = '⏰ 本群定时任务列表：\n';
            tasks.forEach((t, i) => {
                const loopStr = t.is_loop === 1 ? '🔁 循环' : '1️⃣ 单次';
                reply += `${i + 1}. [ID:${t.id}] ${loopStr} | 每天 ${t.trigger_time} 执行 -> ${t.command}\n`;
            });
            return reply.trim() + '\n\n💡 删除请发送：删除定时 [ID]';
        }

        // ================= 删除定时 =================
        if (pureText.startsWith('删除定时')) {
            const match = pureText.match(/^删除定时\s+(\d+)$/);
            if (!match) return '⚠️ 用法：#删除定时 [ID]';
            
            const id = parseInt(match[1]);
            const check = db.prepare('SELECT * FROM scheduler_tasks WHERE id = ? AND group_id = ?').get(id, String(chatId));
            
            if (!check) return '❌ 找不到该 ID 的任务，或者不属于本群。';
            
            db.prepare('DELETE FROM scheduler_tasks WHERE id = ?').run(id);
            return `✅ 已成功删除 ID 为 ${id} 的定时任务。`;
        }
    }
};