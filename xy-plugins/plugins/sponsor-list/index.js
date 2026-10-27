import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'sponsor.db');

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

export default {
    name: '赞助系统',
    
    match(text) {
        if (!text || typeof text !== 'string') return false;
        return text.startsWith('赞助');
    },

    async handle(msg) {
        if (!msg.isGroup) return false;

        const cmd = (msg.pureText || "").trim(); 
        const groupId = String(msg.chatId); 
        const senderQQ = String(msg.senderQQ);
        
        if (cmd.startsWith('赞助设置') || cmd.startsWith('赞助查询') || cmd.startsWith('赞助删除')) {
            return await this.handleAdmin(msg, cmd, groupId, senderQQ);
        }

        if (cmd === '赞助') {
            const items = db.prepare('SELECT * FROM sponsor_items ORDER BY id ASC').all();
            if (items.length === 0) return '⚠️ 机器人尚未设置任何赞助码！请群管发送：赞助设置 [说明] [附带图片]';
            if (items.length === 1) return await this.sendSponsor(msg, items[0]);

            let menuMsg = `💎 【赞助通道】\n提供了 ${items.length} 种赞助方式，请回复对应的编号获取：\n\n`;
            items.forEach(item => { menuMsg += `[ID: ${item.id}] ➡️ ${item.title}\n`; });
            menuMsg += `\n💡 例如发送：赞助 ${items[0].id} 即可获取对应的收款码。`;
            return menuMsg.trim();
        }

        const sponsorMatch = cmd.match(/^赞助\s*(\d+)$/);
        if (sponsorMatch) {
            const id = parseInt(sponsorMatch[1]);
            if (isNaN(id)) return '⚠️ 格式错误！请发送：赞助 [编号]（例如：赞助 1）';

            const item = db.prepare('SELECT * FROM sponsor_items WHERE id = ?').get(id);
            if (!item) return `⚠️ 找不到 ID 为 ${id} 的赞助码。`;

            return await this.sendSponsor(msg, item);
        }

        return false;
    },

    async sendSponsor(msg, item) {
        // 🌟 因为存的是 base64，所以这里发出去绝对稳
        const messages = [
            { type: 'text', data: { text: `💎 【赞助通道】\n📢 ${item.title}\n👇 请使用下方赞助码：` } },
            { type: 'image', data: { file: item.qr_url } }
        ];
        
        try {
            globalThis.print(`[赞助系统] 正在发送图片...`);
            const res = await globalThis.wsCall('send_group_msg', { 
                group_id: Number(msg.chatId), 
                message: messages 
            }, 15000, msg._ws); 
            
            // 🌟 修复：兼容各种框架的返回值，防止误报错
            let isSuccess = true;
            if (res) {
                if (res.status && res.status !== 'ok') isSuccess = false;
                if (res.retcode !== undefined && res.retcode !== 0 && res.retcode !== 1) isSuccess = false;
            }
            
            if (!isSuccess) {
                 const errDetail = res?.msg || res?.wording || res?.message || JSON.stringify(res) || '未知错误';
                 return `❌ 发送失败，NapCat 返回错误: ${errDetail}`;
            }
            return true; // 成功则不回复任何多余文字，让图片安静地发出去
        } catch (e) {
            globalThis.print(`[赞助系统] ❌ 发送抛出异常: ${e.message}`);
            return `❌ 发送失败: ${e.message}`;
        }
    },

    async handleAdmin(msg, cmd, groupId, senderQQ) {
        let hasPermission = false;

        try {
            const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(groupId) : [];
            let memberInfo = cachedMembers.find(m => String(m.user_id) === senderQQ);

            if (!memberInfo) {
                const res = await globalThis.wsCall('get_group_member_info', { 
                    group_id: Number(groupId), user_id: Number(senderQQ) 
                }, 5000, msg._ws);
                if (res?.data) memberInfo = res.data;
            }
            if (memberInfo && ['owner', 'admin'].includes(memberInfo.role)) hasPermission = true;
        } catch (e) {}

        if (!hasPermission && typeof getRole === 'function') {
            if (['master', 'owner', 'admin'].includes(getRole(senderQQ, msg.botId))) hasPermission = true;
        }
        
        if (!hasPermission) return '❌ 权限不足：仅群管或主人可操作。';

        // ==========================================
        // 赞助设置 (核心：下载并转 Base64)
        // ==========================================
        if (cmd.startsWith('赞助设置')) {
            const title = cmd.replace('赞助设置', '').trim() || '赞助码';
            let targetUrl = null;

            // 1. 找当前消息里的图
            if (Array.isArray(msg.message)) {
                const imgItem = msg.message.find(item => item?.type === 'image');
                if (imgItem && imgItem.data) targetUrl = imgItem.data.url || imgItem.data.file;
            }

            // 2. 找引用消息里的图
            if (!targetUrl && Array.isArray(msg.message)) {
                const replyItem = msg.message.find(item => item?.type === 'reply');
                if (replyItem && replyItem.data && replyItem.data.id) {
                    try {
                        const res = await globalThis.wsCall('get_msg', { 
                            message_id: Number(replyItem.data.id) 
                        }, 5000, msg._ws);
                        if (res && res.data && Array.isArray(res.data.message)) {
                            const refImgItem = res.data.message.find(item => item?.type === 'image');
                            if (refImgItem && refImgItem.data) {
                                targetUrl = refImgItem.data.url || refImgItem.data.file;
                            }
                        }
                    } catch (e) {}
                }
            }

            if (!targetUrl) return '❌ 设置失败：未检测到图片！请直接附带图片发送，或引用一张图片发送该指令。';

            // 🌟 核心修复：下载图片转为 Base64
            globalThis.print(`[赞助系统] 正在下载并保存图片...`);
            let base64Image = '';
            try {
                if (targetUrl.startsWith('base64://')) {
                    base64Image = targetUrl;
                } else {
                    const fetchRes = await fetch(targetUrl);
                    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
                    const arrayBuffer = await fetchRes.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    base64Image = `base64://${buffer.toString('base64')}`;
                }
            } catch (e) {
                globalThis.print(`[赞助系统] 下载图片失败: ${e.message}`);
                return `❌ 图片下载失败（可能链接已过期），请直接发送图片并输入指令，不要引用太久的旧消息。`;
            }

            let targetId = 1;
            while (true) {
                const exist = db.prepare('SELECT id FROM sponsor_items WHERE id = ?').get(targetId);
                if (!exist) break;
                targetId++;
            }

            // 把永久有效的 base64Image 存入数据库
            db.prepare('INSERT INTO sponsor_items (id, title, qr_url, create_time) VALUES (?, ?, ?, ?)')
              .run(targetId, title, base64Image, Math.floor(Date.now() / 1000));
            
            return `✅ 赞助设置成功！\n📢 标签：${title}\n🖼️ 图片已永久保存至本地数据库。\n[🏷️ 自动分配 ID: ${targetId}]`;
        }

        // ==========================================
        // 赞助查询
        // ==========================================
        if (cmd.startsWith('赞助查询')) {
            const items = db.prepare('SELECT * FROM sponsor_items ORDER BY id ASC').all();
            if (items.length === 0) return '📊 机器人的赞助柜子为空。';
            let reply = `📊 【全局赞助柜子状态】共 ${items.length} 个：\n\n`;
            items.forEach(item => { reply += `[ID: ${item.id}] ${item.title}\n`; });
            return reply.trim();
        }

        // ==========================================
        // 赞助删除
        // ==========================================
        if (cmd.startsWith('赞助删除')) {
            const id = parseInt(cmd.replace('赞助删除', '').trim());
            if (isNaN(id)) return '⚠️ 用法：赞助删除 [ID]';
            const info = db.prepare('DELETE FROM sponsor_items WHERE id = ?').run(id);
            return info.changes > 0 ? `✅ 已删除 [ID: ${id}] 的赞助码。` : `⚠️ 找不到该赞助码。`;
        }
    }
};