import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'sponsor.db');
const IMG_DIR = path.join(__dirname, 'sponsor_images'); // 🌟 新增：本地图片存储目录

// 确保图片目录存在
if (!fs.existsSync(IMG_DIR)) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
}

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

// 🌟 新增：管理员权限缓存 Map
// 结构：Map<群号_QQ号, { hasPermission: boolean, expire: number }>
const roleCache = new Map(); 

export default {
    name: '赞助系统',
    
    match(text) {
        if (!text || typeof text !== 'string') return false;
        // 🌟 优化：精确匹配，防止“群主赞助我点钱”误触发
        return /^赞助(?:\s*\d+|\s*(?:设置|查询|删除).*)?$/.test(text);
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
        // 兼容处理：如果是旧数据（base64开头）直接发；如果是新数据（文件名），则读取本地文件转base64
        let finalImageUrl = item.qr_url;
        if (!finalImageUrl.startsWith('base64://')) {
            const filePath = path.join(IMG_DIR, finalImageUrl);
            if (!fs.existsSync(filePath)) {
                return `❌ 发送失败：本地图片丢失（${finalImageUrl}）`;
            }
            try {
                const buffer = fs.readFileSync(filePath);
                finalImageUrl = `base64://${buffer.toString('base64')}`;
            } catch (err) {
                return `❌ 读取本地图片失败：${err.message}`;
            }
        }

        const messages = [
            { type: 'text', data: { text: `💎 【赞助通道】\n📢 ${item.title}\n👇 请使用下方赞助码：` } },
            { type: 'image', data: { file: finalImageUrl } }
        ];
        
        try {
            globalThis.print(`[赞助系统] 正在发送图片...`);
            const res = await globalThis.wsCall('send_group_msg', { 
                group_id: Number(msg.chatId), 
                message: messages 
            }, 15000, msg._ws); 
            
            let isSuccess = true;
            if (res) {
                if (res.status && res.status !== 'ok') isSuccess = false;
                if (res.retcode !== undefined && res.retcode !== 0 && res.retcode !== 1) isSuccess = false;
            }
            
            if (!isSuccess) {
                 const errDetail = res?.msg || res?.wording || res?.message || JSON.stringify(res) || '未知错误';
                 return `❌ 发送失败，NapCat 返回错误: ${errDetail}`;
            }
            return true; 
        } catch (e) {
            globalThis.print(`[赞助系统] ❌ 发送抛出异常: ${e.message}`);
            return `❌ 发送失败: ${e.message}`;
        }
    },

    async handleAdmin(msg, cmd, groupId, senderQQ) {
        let hasPermission = false;
        const cacheKey = `${groupId}_${senderQQ}`;

        // 🌟 优化 1：先查内存缓存
        const cached = roleCache.get(cacheKey);
        if (cached && cached.expire > Date.now()) {
            hasPermission = cached.hasPermission;
        } else {
            // 缓存失效或没有，去查真实数据
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

            // 写入缓存，有效期 5 分钟 (300,000 毫秒)
            roleCache.set(cacheKey, { hasPermission, expire: Date.now() + 300000 });
        }
        
        if (!hasPermission) return '❌ 权限不足：仅群管或主人可操作。';

        // ==========================================
        // 赞助设置
        // ==========================================
        if (cmd.startsWith('赞助设置')) {
            const title = cmd.replace('赞助设置', '').trim() || '赞助码';
            let targetUrl = null;

            if (Array.isArray(msg.message)) {
                const imgItem = msg.message.find(item => item?.type === 'image');
                if (imgItem && imgItem.data) targetUrl = imgItem.data.url || imgItem.data.file;
            }

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

            globalThis.print(`[赞助系统] 正在下载并保存图片...`);
            let fileName = '';
            try {
                if (targetUrl.startsWith('base64://')) {
                    // 如果直接传的是 base64，也存为本地文件
                    const rawBase64 = targetUrl.replace('base64://', '');
                    fileName = `${Date.now()}.jpg`;
                    fs.writeFileSync(path.join(IMG_DIR, fileName), Buffer.from(rawBase64, 'base64'));
                } else {
                    // 🌟 优化 2：SSRF 防护，检查域名是否属于腾讯 QQ 相关域名
                    const urlObj = new URL(targetUrl);
                    const allowedHosts = ['qq.com', 'qpic.cn', 'gchat.qpic.cn', 'qlogo.cn'];
                    const isAllowed = allowedHosts.some(host => urlObj.hostname.endsWith(host));
                    
                    if (!isAllowed) {
                        globalThis.print(`[赞助系统] 拦截到非法图片域名请求: ${urlObj.hostname}`);
                        return `❌ 图片域名不被信任，请直接从 QQ 发送或引用图片。`;
                    }

                    const fetchRes = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) }); // 10秒超时
                    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
                    
                    const arrayBuffer = await fetchRes.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    
                    // 生成随机文件名，避免高并发时重名覆盖
                    fileName = `${Date.now()}_${Math.floor(Math.random() * 10000)}.jpg`; 
                    fs.writeFileSync(path.join(IMG_DIR, fileName), buffer);
                }
            } catch (e) {
                globalThis.print(`[赞助系统] 下载图片失败: ${e.message}`);
                return `❌ 图片下载失败（可能链接已过期或网络问题），请直接发送图片并输入指令。`;
            }

            let targetId = 1;
            while (true) {
                const exist = db.prepare('SELECT id FROM sponsor_items WHERE id = ?').get(targetId);
                if (!exist) break;
                targetId++;
            }

            // 存的是本地的文件名
            db.prepare('INSERT INTO sponsor_items (id, title, qr_url, create_time) VALUES (?, ?, ?, ?)')
              .run(targetId, title, fileName, Math.floor(Date.now() / 1000));
            
            return `✅ 赞助设置成功！\n📢 标签：${title}\n🖼️ 图片已永久保存至本地服务器。\n[🏷️ 自动分配 ID: ${targetId}]`;
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
            
            // 🌟 优化 3：删除记录时，同步删除本地图片文件，防止磁盘空间被垃圾文件占满
            const item = db.prepare('SELECT qr_url FROM sponsor_items WHERE id = ?').get(id);
            if (item && item.qr_url && !item.qr_url.startsWith('base64://')) {
                const filePath = path.join(IMG_DIR, item.qr_url);
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch(e) { globalThis.print(`[赞助系统] 清理旧图片失败: ${e.message}`); }
                }
            }

            const info = db.prepare('DELETE FROM sponsor_items WHERE id = ?').run(id);
            return info.changes > 0 ? `✅ 已删除 [ID: ${id}] 的赞助码及本地缓存。` : `⚠️ 找不到该赞助码。`;
        }
    }
};