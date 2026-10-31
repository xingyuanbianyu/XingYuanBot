import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { getRole } from '../../../xy-config/config/permissions.js';

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
    is_loop INTEGER DEFAULT 0,
    is_raw INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0
  )
`);

// 兼容旧表结构升级
try { db.exec(`ALTER TABLE scheduler_tasks ADD COLUMN is_loop INTEGER DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE scheduler_tasks ADD COLUMN is_raw INTEGER DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE scheduler_tasks ADD COLUMN fail_count INTEGER DEFAULT 0`); } catch (e) {}

let tickCount = 0;
let configCache = {};
let isPolling = false; // 🌟 核心修复：轮询锁，防止单次处理过慢导致定时器重叠、重复触发

// 热更新配置
try {
    if (fs.existsSync(CONFIG_PATH)) {
        configCache = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
        // 增加 fs.watch 容错，防止部分系统不支持导致崩溃
        try {
            fs.watch(CONFIG_PATH, () => {
                try {
                    configCache = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
                    globalThis.print('[定时调度] 👀 配置文件已热更新');
                } catch (e) {}
            });
        } catch (e) {
            globalThis.print('[定时调度] ⚠️ 当前环境不支持文件热更新');
        }
    }
} catch (e) {}

// ================= 辅助函数：解析 @QQ号 为消息段 =================
function parseAtSegments(text) {
    const segments = [];
    const atRegex = /@(\d{5,12})/g;
    let lastIndex = 0;
    let match;

    while ((match = atRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: 'text', data: { text: text.slice(lastIndex, match.index) } });
        }
        segments.push({ type: 'at', data: { qq: match[1] } });
        lastIndex = atRegex.lastIndex;
    }
    if (lastIndex < text.length) {
        segments.push({ type: 'text', data: { text: text.slice(lastIndex) } });
    }
    if (segments.length === 0) {
        segments.push({ type: 'text', data: { text } });
    }
    return segments;
}

// ================= 核心轮询器 =================
setInterval(async () => {
    // 1. 互斥锁检查
    if (isPolling) return;
    if (configCache.enabled === false) return;

    isPolling = true; // 上锁，标记当前正在处理
    
    try {
        tickCount++;
        if (tickCount % 6 === 0) {
            const count = db.prepare('SELECT COUNT(*) as c FROM scheduler_tasks').get().c;
            if (count > 0) globalThis.print(`[定时调度] 轮询运行中... 共 ${count} 个任务`);
        }

        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        
        // 2. 查询条件增加 fail_count < 3，失败的超过3次不再尝试（防止死循环）
        const tasks = db.prepare('SELECT * FROM scheduler_tasks WHERE (last_run_date IS NULL OR last_run_date != ?) AND fail_count < 3').all(todayStr);
        if (tasks.length === 0) {
            isPolling = false;
            return;
        }

        const activeWs = globalThis.activeWs || globalThis._ws;
                         
        if (!activeWs || activeWs.readyState !== 1) {
            isPolling = false;
            return; 
        }

        for (const task of tasks) {
            const [th, tm] = task.trigger_time.split(':').map(Number);
            const taskDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), th, tm, 0);
            
            const diffMs = now.getTime() - taskDate.getTime();
            const diffMinutes = diffMs / (1000 * 60);

            // 过了时间且在 3 小时内就触发
            if (diffMinutes >= 0 && diffMinutes <= 180) {
                
                globalThis.print(`\n========================================`);
                globalThis.print(`[定时调度] 🎯 触发任务! 群:${task.group_id} 指令:${task.command}`);
                globalThis.print(`========================================\n`);

                let isSuccess = false; // 用于记录本次任务是否执行成功

                // ==========================================
                // 🌟 模式 A：带 -r 的任务（直接发群消息，不走插件）
                // ==========================================
                if (task.is_raw === 1) {
                    try {
                        const messageSegments = parseAtSegments(task.command);
                        await globalThis.wsCall('send_group_msg', {
                            group_id: Number(task.group_id),
                            message: messageSegments
                        }, 5000, activeWs);
                        
                        isSuccess = true;
                        globalThis.print(`[定时调度] ✅ 直接发送成功 (纯文本/艾特)`);
                    } catch (e) {
                        globalThis.print(`[定时调度] ❌ 直接发送失败: ${e.message}`);
                    }
                } 
                // ==========================================
                // 🌟 模式 B：默认任务（伪造消息注入，走插件）
                // ==========================================
                else {
                    let userRole = 'member';
                    let userNick = '定时任务';
                    
                    try {
                        const res = await globalThis.wsCall('get_group_member_info', { 
                            group_id: String(task.group_id), 
                            user_id: String(task.creator_id) 
                        }, 5000, activeWs);
                        
                        const info = res?.data || res;
                        if (info) {
                            if (info.role) userRole = info.role; 
                            if (info.card || info.nickname) {
                                userNick = info.card || info.nickname;
                            }
                        }
                    } catch (e) {
                        globalThis.print(`[定时调度] ⚠️ 获取成员信息失败: ${e.message}`);
                    }

                    const messageSegments = parseAtSegments(task.command);
                    const rawCQMessage = messageSegments.map(seg => {
                        if (seg.type === 'text') return seg.data.text;
                        if (seg.type === 'at') return `[CQ:at,qq=${seg.data.qq}]`;
                        return '';
                    }).join('');

                    const fakeMsgData = {
                        time: Math.floor(Date.now() / 1000),
                        self_id: Number(globalThis.botInfo?.qq || 10000), 
                        post_type: "message",
                        message_type: "group",
                        sub_type: "normal",
                        message_id: Date.now() + Math.floor(Math.random() * 1000),
                        group_id: Number(task.group_id),
                        user_id: Number(task.creator_id),
                        raw_message: rawCQMessage, 
                        font: 0,
                        sender: { 
                            user_id: Number(task.creator_id), 
                            nickname: userNick, 
                            card: userNick,
                            role: userRole 
                        },
                        message: messageSegments 
                    };

                    if (typeof globalThis.handleIncomingMessage === 'function') {
                        try {
                            globalThis.handleIncomingMessage(JSON.stringify(fakeMsgData), activeWs, globalThis._registry, globalThis._plugins);
                            isSuccess = true;
                            globalThis.print(`[定时调度] ✅ 注入完成`);
                        } catch (e) {
                            globalThis.print(`[定时调度] ❌ 注入伪消息失败: ${e.message}`);
                        }
                    }
                }

                // ==========================================
                // 🌟 结果处理：成功就更新/删除，失败就记录重试
                // ==========================================
                if (isSuccess) {
                    if (task.is_loop === 1) {
                        // 循环任务，更新日期并重置失败次数
                        db.prepare('UPDATE scheduler_tasks SET last_run_date = ?, fail_count = 0 WHERE id = ?').run(todayStr, task.id);
                    } else {
                        // 单次任务，执行成功直接删除
                        db.prepare('DELETE FROM scheduler_tasks WHERE id = ?').run(task.id);
                    }
                } else {
                    // 执行失败，失败次数 +1，留给下一个 10 秒重试
                    db.prepare('UPDATE scheduler_tasks SET fail_count = fail_count + 1 WHERE id = ?').run(task.id);
                    globalThis.print(`[定时调度] ⚠️ 任务 ID:${task.id} 执行失败，已记录重试次数`);
                }
            }
        }
    } catch (err) {
        globalThis.print(`[定时调度] 💥 轮询异常: ${err.message}`);
    } finally {
        // 3. 无论成功、失败还是异常，最后必须解锁
        isPolling = false; 
    }
}, 10000);


export default {
    name: '定时调度',

    match(text) {
        if (typeof text !== 'string') return false;
        // 🌟 优化：精确匹配，防止“添加定时炸弹”之类的词汇被误触
        return /^(添加定时|查看定时|删除定时)(\s+|$)/.test(text.trim());
    },

    async handle(msg) {
        const pureText = (msg.pureText || "").trim();
        const chatId = msg.chatId;
        const senderQQ = msg.senderQQ;
        const botId = msg.botId;

        const userRole = typeof getRole === 'function' ? getRole(senderQQ, botId) : 'member';
        const isMaster = userRole === 'master' || userRole === 'owner';
        const isGroupAdmin = msg.sender?.role === 'admin' || msg.sender?.role === 'owner';
        
        if (!isMaster && !isGroupAdmin) {
            return '❌ 权限不足：仅群主/管理员/机器人主人可使用定时指令。';
        }

        // ================= 添加定时 =================
        if (pureText.startsWith('添加定时')) {
            const match = pureText.match(/^添加定时\s+(\d{1,2}:\d{1,2})\s*(?:\/|\s)\s*(.+)$/);
            if (!match) return '⚠️ 格式错误！\n用法：#添加定时 08:30 / #打卡 [开/关]';

            let timeStr = match[1];
            let rest = match[2].trim();
            let isLoop = 0; 
            let isRaw = 0; 

            // 提取结尾的 -r
            const rawMatch = rest.match(/(.+?)\s+-r$/i);
            if (rawMatch) {
                isRaw = 1;
                rest = rawMatch[1].trim();
            }

            // 提取循环标记
            const loopMatch = rest.match(/(.+?)\s+(开|循环|关|一次)$/);
            if (loopMatch) {
                const mode = loopMatch[2];
                if (mode === '开' || mode === '循环') isLoop = 1;
                rest = loopMatch[1].trim(); 
            }

            const [h, m] = timeStr.split(':');
            timeStr = `${String(parseInt(h)).padStart(2, '0')}:${String(parseInt(m)).padStart(2, '0')}`;

            db.prepare('INSERT INTO scheduler_tasks (group_id, trigger_time, command, creator_id, is_loop, is_raw) VALUES (?, ?, ?, ?, ?, ?)')
              .run(String(chatId), timeStr, rest, String(senderQQ), isLoop, isRaw);

            const loopStatus = isLoop === 1 ? '开 (每天循环)' : '关 (只执行一次)';
            const rawStatus = isRaw === 1 ? '开启 (直接群发)' : '关闭 (作为指令触发)';
            
            return `✅ 定时任务添加成功！\n⏱️ 触发时间：每天 ${timeStr}\n📝 触发内容：${rest}\n🔄 循环开关：${loopStatus}\n⚙️ 执行模式：${rawStatus}`;
        }

        // ================= 查看定时 =================
        if (pureText.startsWith('查看定时')) {
            const tasks = db.prepare('SELECT * FROM scheduler_tasks WHERE group_id = ?').all(String(chatId));
            if (!tasks || tasks.length === 0) return '📭 当前群没有设置任何定时任务。';
            
            let reply = '⏰ 本群定时任务列表：\n';
            tasks.forEach((t, i) => {
                const loopStr = t.is_loop === 1 ? '🔁 循环' : '1️⃣ 单次';
                const rawStr = t.is_raw === 1 ? ' [直接群发]' : '';
                reply += `${i + 1}. [ID:${t.id}] ${loopStr}${rawStr} | 每天 ${t.trigger_time} 执行 -> ${t.command}\n`;
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