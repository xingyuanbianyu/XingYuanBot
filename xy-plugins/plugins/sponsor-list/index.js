// xy-plugins/QQ/sponsor-list/index.js
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'sponsor.db');
const GLOBAL_CONFIG_PATH = path.join(process.cwd(), 'xy-config/config.yaml');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sponsor_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    qr_url TEXT,
    create_time INTEGER
  );
`);

// ==========================================
// 🌟 动态获取全局前缀配置函数
// ==========================================
function getDynamicPrefixes() {
    let prefixes = ['/', '$', '#', '!', '。']; // 兜底
    try {
        if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
            const authConfig = yaml.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) || {};
            if (authConfig.command_prefix && Array.isArray(authConfig.command_prefix.prefixes)) {
                prefixes = authConfig.command_prefix.prefixes;
            }
        }
    } catch (e) {}
    return prefixes;
}

// ==========================================
// 🌟 公共前缀剥离函数（使用动态前缀）
// ==========================================
function stripPrefix(text) {
    let cmd = (text || "").trim();
    const dynamicPrefixes = getDynamicPrefixes();
    for (const p of dynamicPrefixes) {
        if (cmd.startsWith(p)) { 
            cmd = cmd.slice(p.length).trim(); 
            break; 
        }
    }
    return cmd;
}

export default {
    name: '赞助系统',
    
    match(text) {
        if (!text || typeof text !== 'string') return false;
        const cmd = stripPrefix(text);
        return cmd.startsWith('赞助');
    },

    async handle(msg) {
        if (!msg.isGroup) return false;

        const cmd = stripPrefix(msg.pureText || "");
        
        const groupId = String(msg.chatId); 
        const senderQQ = String(msg.senderQQ);

        // ==========================================
        // 拦截管理指令
        // ==========================================
        if (cmd.startsWith('赞助设置') || cmd.startsWith('赞助查询') || cmd.startsWith('赞助删除')) {
            return await this.handleAdmin(msg, cmd, groupId, senderQQ);
        }

        // ==========================================
        // 群友指令：赞助 或 赞助 [ID]
        // ==========================================
        if (cmd === '赞助') {
            const items = db.prepare('SELECT * FROM sponsor_items ORDER BY id ASC').all();
            
            if (items.length === 0) {
                return '⚠️ 机器人尚未设置任何赞助码！请群管发送：赞助设置 [说明] [附带图片]';
            }

            if (items.length === 1) {
                return await this.sendSponsor(groupId, items[0]);
            }

            let menuMsg = `💎 【赞助通道】\n提供了 ${items.length} 种赞助方式，请回复对应的编号获取：\n\n`;
            items.forEach(item => {
                menuMsg += `[ID: ${item.id}] ➡️ ${item.title}\n`;
            });
            menuMsg += `\n💡 例如发送：赞助 ${items[0].id} 即可获取对应的收款码。`;
            return menuMsg.trim();
        }

        const sponsorMatch = cmd.match(/^赞助\s*(\d+)$/);
        if (sponsorMatch) {
            const id = parseInt(sponsorMatch[1]);
            if (isNaN(id)) return '⚠️ 格式错误！请发送：赞助 [编号]（例如：赞助 1）';

            const item = db.prepare('SELECT * FROM sponsor_items WHERE id = ?').get(id);
            if (!item) return `⚠️ 找不到 ID 为 ${id} 的赞助码。`;

            return await this.sendSponsor(groupId, item);
        }

        return false;
    },

    async sendSponsor(groupId, item) {
        const messages = [
            { type: 'text', data: { text: `💎 【赞助通道】\n📢 ${item.title}\n👇 请使用下方赞助码：` } },
            { type: 'image', data: { file: item.qr_url } }
        ];
        try {
            await globalThis.wsCall('send_group_msg', { group_id: Number(groupId), message: messages });
            return true;
        } catch (e) {
            globalThis.print(`[赞助] 发送失败: ${e.message}`);
            return false;
        }
    },

    async handleAdmin(msg, cmd, groupId, senderQQ) {
        let hasPermission = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(groupId), user_id: Number(senderQQ) });
            if (['owner', 'admin'].includes(res?.data?.role)) hasPermission = true;
        } catch (e) {}
        if (!hasPermission && typeof getRole === 'function') {
            if (['master', 'owner', 'admin'].includes(getRole(senderQQ))) hasPermission = true;
        }
        if (!hasPermission) return '❌ 权限不足：仅群管或主人可操作。';

        // ==========================================
        // 🌟 赞助设置（智能填补空缺 ID）
        // ==========================================
        if (cmd.startsWith('赞助设置')) {
            const title = cmd.replace('赞助设置', '').trim() || '赞助码';
            let qrUrl = null;

            if (Array.isArray(msg.message)) {
                const imgItem = msg.message.find(item => item?.type === 'image');
                if (imgItem && imgItem.data) {
                    qrUrl = imgItem.data.url || imgItem.data.file;
                }
            }

            if (!qrUrl && Array.isArray(msg.message)) {
                const replyItem = msg.message.find(item => item?.type === 'reply');
                if (replyItem && replyItem.data && replyItem.data.id) {
                    try {
                        const res = await globalThis.wsCall('get_msg', { message_id: Number(replyItem.data.id) });
                        if (res && res.data && Array.isArray(res.data.message)) {
                            const refImgItem = res.data.message.find(item => item?.type === 'image');
                            if (refImgItem && refImgItem.data) {
                                qrUrl = refImgItem.data.url || refImgItem.data.file;
                            }
                        }
                    } catch (e) {
                        globalThis.print(`[赞助] 获取引用消息失败: ${e.message}`);
                    }
                }
            }

            if (!qrUrl) {
                return '❌ 设置失败：未检测到图片！请直接附带图片发送，或引用一张图片发送该指令。';
            }

            // 🌟 核心修复：动态填补空缺 ID
            let targetId = 1;
            // 从 1 开始一直往上找，直到找到一个数据库里没有的 ID
            while (true) {
                const exist = db.prepare('SELECT id FROM sponsor_items WHERE id = ?').get(targetId);
                if (!exist) break; // 这个 ID 空缺，就用它！
                targetId++;
            }

            // 强行指定 ID 插入
            db.prepare('INSERT INTO sponsor_items (id, title, qr_url, create_time) VALUES (?, ?, ?, ?)')
              .run(targetId, title, qrUrl, Math.floor(Date.now() / 1000));
            
            return `✅ 赞助设置成功！\n📢 标签：${title}\n🖼️ 已成功从${msg.message.some(i => i.type === 'image') ? '当前消息' : '引用消息'}中提取图片。\n[🏷️ 自动分配 ID: ${targetId}]`;
        }

        // ==========================================
        // 赞助查询
        // ==========================================
        if (cmd.startsWith('赞助查询')) {
            const items = db.prepare('SELECT * FROM sponsor_items ORDER BY id ASC').all();
            if (items.length === 0) return '📊 机器人的赞助柜子为空。';
            let reply = `📊 【全局赞助柜子状态】共 ${items.length} 个：\n\n`;
            items.forEach(item => { reply += `[ID: ${item.id}] ${item.title}\n`; });
            reply += `\n💡 发送：赞助删除 [ID] 可丢弃。`;
            return reply.trim();
        }

        // ==========================================
        // 赞助删除
        // ==========================================
        if (cmd.startsWith('赞助删除')) {
            const id = parseInt(cmd.replace('赞助删除', '').trim());
            if (isNaN(id)) return '⚠️ 用法：赞助删除 [ID]';
            const info = db.prepare('DELETE FROM sponsor_items WHERE id = ?').run(id);
            return info.changes > 0 ? `✅ 已删除 [ID: ${id}] 的赞助码（全局生效）。` : `⚠️ 找不到该赞助码。`;
        }
    }
};