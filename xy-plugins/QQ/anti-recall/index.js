import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getAllOwners, getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');

const DB_PATH = path.join(__dirname, 'anti_recall.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ==========================================
// 🌟 核心：数据库无感升级 (支持一个主人绑定多个群)
// ==========================================
try {
    const tableInfo = db.prepare("PRAGMA table_info(exclusive_push)").all();
    const pkCount = tableInfo.filter(col => col.pk > 0).length;
    
    // 如果表存在，且主键只有1个（旧版结构），则进行迁移
    if (tableInfo.length > 0 && pkCount === 1 && tableInfo.find(c => c.name === 'user_id' && c.pk === 1)) {
        globalThis.print('[防撤回] 🔄 正在升级数据库，支持多群绑定拦截...');
        db.exec(`
            ALTER TABLE exclusive_push RENAME TO exclusive_push_old;
            CREATE TABLE exclusive_push (
                user_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                PRIMARY KEY (user_id, group_id)
            );
            INSERT OR IGNORE INTO exclusive_push (user_id, group_id) SELECT user_id, group_id FROM exclusive_push_old;
            DROP TABLE exclusive_push_old;
        `);
        globalThis.print('[防撤回] ✅ 数据库升级完成！');
    } else {
        db.exec(`
            CREATE TABLE IF NOT EXISTS exclusive_push (
                user_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                PRIMARY KEY (user_id, group_id)
            )
        `);
    }
} catch (e) {
    globalThis.print(`[防撤回] ⚠️ 数据库检查/升级失败: ${e.message}`);
    // 兜底建表
    db.exec(`
        CREATE TABLE IF NOT EXISTS exclusive_push (
            user_id TEXT NOT NULL,
            group_id TEXT NOT NULL,
            PRIMARY KEY (user_id, group_id)
        )
    `);
}

// ==========================================
// 🌟 优化 1：定时清理缓存，防止 setTimeout 堆积导致内存泄漏
// ==========================================
const backupCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [msgId, data] of backupCache.entries()) {
        if (now - data._cacheTime > CACHE_TIME) {
            backupCache.delete(msgId);
        }
    }
}, 60000); // 每分钟清理一次过期缓存

let friendListCache = new Set();
let lastFriendFetchTime = 0;
const FRIEND_CACHE_EXPIRE = 5 * 60 * 1000;

let recallBrowser = null;
let browserLaunching = null;
let isRendering = false; // 🌟 核心修复：渲染并发锁

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function parseSegmentsToHtml(segments) {
    let html = '';
    if (!Array.isArray(segments)) return escapeHtml(String(segments));

    for (const seg of segments) {
        if (seg.type === 'text') {
            html += escapeHtml(seg.data.text).replace(/\n/g, '<br>');
        } else if (seg.type === 'image') {
            let url = seg.data.url || seg.data.file;
            if (url && !url.startsWith('base64://')) {
                if (url.startsWith('http')) {
                    html += `<div class="img-box"><img src="${url}" onerror="this.style.display='none'" /></div>`; // 🌟 优化：加载失败的图片自动隐藏
                } else if (url.startsWith('{')) {
                    try {
                        const json = JSON.parse(url);
                        if (json.url) html += `<div class="img-box"><img src="${json.url}" onerror="this.style.display='none'" /></div>`;
                    } catch(e) {}
                }
            } else {
                html += `<span class="badge-tag">[图片]</span>`;
            }
        } else if (seg.type === 'face') {
            html += `<span class="badge-tag">[表情]</span>`;
        } else if (seg.type === 'record') {
            html += `<span class="badge-tag">[语音]</span>`;
        } else if (seg.type === 'video') {
            html += `<span class="badge-tag">[视频]</span>`;
        } else if (seg.type === 'at') {
            html += `<span class="badge-tag">@${seg.data.qq}</span>`;
        } else {
            html += `<span class="badge-tag">[${seg.type}]</span>`;
        }
    }
    return html;
}

export default {
  name: '防撤回',
  events: ['group.recall', 'friend.recall'],
  ignorePrefix: true, 
  match: () => true,

  loadConfig() {
    try { return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) { return {}; }
  },

  async handle(msg) {
    const config = this.loadConfig();
    if (config.enabled === false) return false;
    
    const raw = msg.rawData || {};
    const senderQQ = String(msg.senderQQ);
    const currentGroupId = msg.isGroup ? String(msg.chatId) : null;
    
    let cmd = (msg.pureText || "").trim(); 

    const isInterceptCmd = cmd.startsWith('指定拦截') || cmd.startsWith('取消拦截') || cmd.startsWith('查看拦截');

    if (isInterceptCmd) {
        const role = getRole(senderQQ, msg.botId);
        if (role !== 'master' && role !== 'owner') return '❌ 权限不足：仅主人可配置专属拦截。';

        if (cmd.startsWith('指定拦截')) {
            const content = cmd.replace('指定拦截', '').trim();
            const match = content.match(/^(\d{5,12})(?:\s+(\d{5,12}))?$/);
            if (!match) return '⚠️ 用法：\n指定拦截 QQ号 群号\n指定拦截 QQ号';
            const targetQQ = match[1];
            const targetGroup = match[2] || currentGroupId;
            
            if (!targetGroup) return '❌ 必须在群内使用，或者显式提供群号。';
            
            const targetRole = getRole(targetQQ, msg.botId);
            if (targetRole !== 'master' && targetRole !== 'owner') return `❌ 设置失败：${targetQQ} 不在有效主人列表中（或权限已关闭）。`;

            // 🌟 使用 INSERT OR IGNORE 防止重复插入
            const info = db.prepare('INSERT OR IGNORE INTO exclusive_push (user_id, group_id) VALUES (?, ?)').run(targetQQ, targetGroup);
            
            if (info.changes > 0) {
                return `✅ 绑定成功！\n主人 ${targetQQ} 现在起会额外接收【群 ${targetGroup}】的撤回通知。`;
            } else {
                return `⚠️ 主人 ${targetQQ} 已经绑定了【群 ${targetGroup}】，无需重复设置。`;
            }
        }

        if (cmd.startsWith('取消拦截')) {
            const content = cmd.replace('取消拦截', '').trim();
            const match = content.match(/^(\d{5,12})(?:\s+(\d{5,12}))?$/);
            
            let targetQQ = senderQQ;
            let targetGroup = null;

            if (match) {
                targetQQ = match[1];
                if (match[2]) targetGroup = match[2];
            }

            if (targetGroup) {
                // 取消指定群的拦截
                const info = db.prepare('DELETE FROM exclusive_push WHERE user_id = ? AND group_id = ?').run(targetQQ, targetGroup);
                return info.changes > 0 ? `✅ 已取消！主人 ${targetQQ} 不再单独接收群 ${targetGroup} 的通知。` : `⚠️ 主人 ${targetQQ} 当前没有绑定群 ${targetGroup}。`;
            } else {
                // 取消该用户的所有拦截
                const info = db.prepare('DELETE FROM exclusive_push WHERE user_id = ?').run(targetQQ);
                return info.changes > 0 ? `✅ 已取消！主人 ${targetQQ} 的所有专属拦截绑定已清空，恢复接收所有群通知。` : `⚠️ 主人 ${targetQQ} 当前没有设置任何专属拦截。`;
            }
        }

        if (cmd.startsWith('查看拦截')) {
            const rows = db.prepare('SELECT user_id, group_id FROM exclusive_push').all();
            if (rows.length === 0) return '⚙️ 当前没有任何主人设置专属拦截。';
            
            // 🌟 按用户分组显示
            const userGroups = {};
            rows.forEach(r => {
                if (!userGroups[r.user_id]) userGroups[r.user_id] = [];
                userGroups[r.user_id].push(r.group_id);
            });

            let reply = '⚙️ 当前专属拦截绑定列表：\n';
            for (const [uid, groups] of Object.entries(userGroups)) {
                reply += `👤 主人 ${uid} ➡️ 只听群：${groups.join(', ')}\n`;
            }
            return reply.trim();
        }
    }

    if (raw.post_type === 'message' && raw.message_id) {
        if (senderQQ === String(msg.botId)) return false;

        backupCache.set(String(raw.message_id), {
            name: msg.senderName || '未知',
            senderId: senderQQ,
            groupId: currentGroupId,
            groupName: msg.isGroup ? (raw.group_name || null) : null,
            content: raw.message || [],
            _cacheTime: Date.now() // 🌟 记录时间戳用于清理
        });
        
        globalThis.print(`[防撤回] 已缓存消息: ${raw.message_id}`);
    }
    return false; 
  },

  async onEvent(eventData, context) {
    const config = this.loadConfig();
    if (config.enabled === false) return;

    const raw = eventData.raw;
    if (!raw) return;

    const selfId = String(eventData.selfId || raw.self_id || '');
    let ws = context?.ws || eventData.ws; 
    if (!ws && selfId && globalThis.sharedState?.botIdToWs) {
        ws = globalThis.sharedState.botIdToWs.get(selfId);
    }
    if (!ws) ws = globalThis.activeWs;

    if (raw.notice_type === 'group_recall' || raw.notice_type === 'friend_recall') {
        const backup = backupCache.get(String(raw.message_id));
        
        if (backup) {
            globalThis.print(`\n[防撤回] 🚨 检测到撤回事件...`);
            let locationStr = '私聊';
            const currentGroupId = backup.groupId; 
            
            if (currentGroupId) {
                let gName = backup.groupName;
                if (!gName && typeof globalThis.wsCall === 'function') {
                    try {
                        const res = await globalThis.wsCall('get_group_info', { group_id: Number(currentGroupId) }, 3000, ws);
                        if (res?.data?.group_name) gName = res.data.group_name;
                    } catch (e) {}
                }
                locationStr = gName ? `${gName}(${currentGroupId})` : `群聊(${currentGroupId})`;
            }

            if (Date.now() - lastFriendFetchTime > FRIEND_CACHE_EXPIRE) {
                try {
                    const res = await globalThis.wsCall('get_friend_list', {}, 10000, ws);
                    let friendsData = null;
                    if (Array.isArray(res)) friendsData = res;
                    else if (res && res.data && Array.isArray(res.data)) friendsData = res.data;
                    
                    if (friendsData) {
                        friendListCache.clear();
                        friendsData.forEach(f => friendListCache.add(String(f.user_id)));
                        lastFriendFetchTime = Date.now();
                        globalThis.print(`[防撤回] 好友列表已刷新，共拉取到 ${friendListCache.size} 个好友。`);
                    } else {
                        globalThis.print(`[防撤回] ⚠️ 好友列表格式异常，本次将尝试盲目发送...`);
                        lastFriendFetchTime = Date.now();
                    }
                } catch(e) {
                    globalThis.print(`[防撤回] 获取好友列表异常: ${e.message}，将尝试盲目发送...`);
                    lastFriendFetchTime = Date.now();
                }
            }

            const allOwners = getAllOwners(selfId);
            if (allOwners.length === 0) {
                globalThis.print(`[防撤回] ⚠️ 当前没有任何有效主人，取消发送。`);
                return;
            }

            const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${backup.senderId}&s=640`;
            const contentHtml = parseSegmentsToHtml(backup.content);

            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; display: inline-block; }
                    .card { background: linear-gradient(145deg, #2b1b1b, #1e1414); border-radius: 20px; width: 480px; padding: 24px; border: 1px solid rgba(255, 80, 80, 0.2); box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5); position: relative; overflow: hidden; }
                    .card::before { content: ''; position: absolute; top: -50px; left: -50px; width: 150px; height: 150px; background: #F44336; filter: blur(80px); opacity: 0.2; z-index: 0; }
                    .content { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 16px; }
                    .header { display: flex; align-items: center; gap: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); padding-bottom: 16px; }
                    .avatar-box { flex-shrink: 0; width: 60px; height: 60px; border-radius: 50%; border: 2px solid #F44336; box-shadow: 0 0 10px rgba(244,67,54,0.4); overflow: hidden; position: relative; }
                    .avatar-box img { width: 100%; height: 100%; object-fit: cover; }
                    .badge { position: absolute; bottom: 0; right: -5px; background: #1e1e24; border-radius: 50%; width: 24px; height: 24px; display: flex; justify-content: center; align-items: center; font-size: 14px; border: 1px solid rgba(255,255,255,0.1); }
                    .info { display: flex; flex-direction: column; gap: 4px; }
                    .info-name { font-size: 18px; color: #fff; font-weight: bold; }
                    .info-loc { font-size: 13px; color: #aaa; }
                    .message { font-size: 16px; color: #eee; line-height: 1.6; background: rgba(0, 0, 0, 0.3); padding: 16px; border-radius: 12px; border-left: 4px solid #F44336; }
                    .img-box { margin-top: 8px; max-width: 100%; border-radius: 8px; overflow: hidden; }
                    .img-box img { max-width: 100%; display: block; }
                    .badge-tag { display: inline-block; background: rgba(255,255,255,0.1); padding: 2px 8px; border-radius: 4px; font-size: 14px; color: #aaa; }
                    .footer { font-size: 12px; color: #666; text-align: right; margin-top: 4px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="content">
                        <div class="header">
                            <div class="avatar-box">
                                <img src="${avatarUrl}">
                                <div class="badge">🚫</div>
                            </div>
                            <div class="info">
                                <div class="info-name">${escapeHtml(backup.name)} (${backup.senderId})</div>
                                <div class="info-loc">来源: ${escapeHtml(locationStr)}</div>
                            </div>
                        </div>
                        <div class="message">${contentHtml}</div>
                        <div class="footer">XingYuanBot 防撤回拦截</div>
                    </div>
                </div>
            </body>
            </html>
            `;

            let imageBuffer = null;

            // 🌟 核心修复 2：渲染并发锁，防止大量撤回瞬间导致内存爆炸
            if (!isRendering) {
                isRendering = true;
                try {
                    let chromium = null;
                    try { chromium = (await import('playwright')).chromium; } catch (e) {}
                    if (chromium) {
                        if (!recallBrowser || !recallBrowser.isConnected()) {
                            if (!browserLaunching) {
                                browserLaunching = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] }).then(b => {
                                    recallBrowser = b; browserLaunching = null; return b;
                                });
                            }
                            await browserLaunching;
                        }
                        const browserContext = await recallBrowser.newContext({ deviceScaleFactor: 2, viewport: { width: 600, height: 800 } });
                        try { 
                            const page = await browserContext.newPage();
                            // 🌟 核心修复 3：改用 domcontentloaded 并增加超时，防止外部图片卡死渲染
                            await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 5000 });
                            await page.waitForTimeout(300); // 给图片300ms加载时间
                            
                            const cardElement = await page.$('.card');
                            if (cardElement) {
                                imageBuffer = await cardElement.screenshot({ type: 'png', omitBackground: true });
                            }
                        } finally {
                            await browserContext.close().catch(()=>{});
                        }
                    }
                } catch (err) {
                    console.error('❌ [防撤回] 渲染图片失败，将降级为纯文本:', err.message);
                } finally {
                    isRendering = false; // 释放渲染锁
                }
            } else {
                globalThis.print(`[防撤回] ⚠️ 渲染并发过高，自动降级为纯文本发送。`);
            }

            const alertText = config.alert_text || '🛑 【防撤回拦截】\n';
            let rawContentStr = '';
            if (Array.isArray(backup.content)) {
                rawContentStr = backup.content.map(c => {
                    if (c.type === 'text') return c.data.text;
                    if (c.type === 'image') return '[图片]';
                    if (c.type === 'face') return '[表情]';
                    return `[${c.type}]`;
                }).join('');
            } else {
                rawContentStr = String(backup.content);
            }

            const fallbackMsg = [
                { type: 'text', data: { text: `${alertText}来源：${locationStr}\n发送者：${backup.name}(${backup.senderId})\n内容：${rawContentStr}\n` } }
            ];

            // 提取需要额外发送的动图 / 视频 / 语音
            const extraMediaMsgs = [];
            if (Array.isArray(backup.content)) {
                for (const seg of backup.content) {
                    if (seg.type === 'video' || seg.type === 'record') {
                        let fileUrl = seg.data.url || seg.data.file;
                        if (fileUrl) {
                            extraMediaMsgs.push({ type: seg.type, data: { file: fileUrl } });
                        }
                    } 
                    else if (seg.type === 'image') {
                        let fileUrl = seg.data.url || seg.data.file;
                        let isGif = (seg.data.sub_type === 1) || (fileUrl && fileUrl.toLowerCase().includes('.gif'));
                        if (fileUrl && isGif) {
                            extraMediaMsgs.push({ type: 'image', data: { file: fileUrl } });
                        }
                    }
                }
            }
            if (extraMediaMsgs.length > 0) {
                globalThis.print(`[防撤回] 发现 ${extraMediaMsgs.length} 个视频/动图，准备额外发送。`);
            }

            // 获取所有绑定关系并按用户分组
            const boundGroupsMap = new Map();
            const rows = db.prepare('SELECT user_id, group_id FROM exclusive_push').all();
            rows.forEach(r => {
                const uid = String(r.user_id);
                if (!boundGroupsMap.has(uid)) boundGroupsMap.set(uid, new Set());
                boundGroupsMap.get(uid).add(String(r.group_id));
            });

            for (const owner of allOwners) {
                if (owner === backup.senderId) continue;

                if (friendListCache.size > 0 && !friendListCache.has(String(owner))) {
                    globalThis.print(`[防撤回] ⏭️ 跳过非好友: ${owner}`);
                    continue; 
                }

                const userBoundGroups = boundGroupsMap.get(String(owner));
                let shouldSend = true;

                // 如果该主人配置了指定群，则只有当当前群在他的绑定列表中时才发送
                if (userBoundGroups && userBoundGroups.size > 0) {
                    if (currentGroupId && !userBoundGroups.has(String(currentGroupId))) {
                        shouldSend = false;
                    }
                }

                if (shouldSend && typeof globalThis.wsCall === 'function') {
                    await new Promise(r => setTimeout(r, 1500)); 
                    
                    let sendSuccess = false;

                    // 1. 先发防撤回卡片
                    if (imageBuffer) {
                        try {
                            await globalThis.wsCall('send_msg', {
                                message_type: 'private',
                                user_id: Number(owner),
                                message: [{ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } }]
                            }, 15000, ws);
                            sendSuccess = true;
                            globalThis.print(`[防撤回] ✅ 成功发送图片给: ${owner}`);
                        } catch (err) {
                            globalThis.print(`❌ [防撤回] 图片发 ${owner} 失败，降级发文本...`);
                        }
                    }
                    
                    if (!sendSuccess) {
                        try {
                            await globalThis.wsCall('send_msg', {
                                message_type: 'private',
                                user_id: Number(owner),
                                message: fallbackMsg
                            }, 15000, ws);
                            globalThis.print(`[防撤回] ✅ (文本降级) 成功发送给: ${owner}`);
                        } catch(err) {
                            globalThis.print(`❌ [防撤回] 文本发 ${owner} 失败: ${err.message}`);
                        }
                    }

                    // 2. 如果存在动图/视频/语音，额外发送原始媒体文件
                    if (extraMediaMsgs.length > 0) {
                        await new Promise(r => setTimeout(r, 1000)); // 稍微停顿一下，防止风控
                        try {
                            await globalThis.wsCall('send_msg', {
                                message_type: 'private',
                                user_id: Number(owner),
                                message: extraMediaMsgs
                            }, 15000, ws);
                            globalThis.print(`[防撤回] ✅ 成功发送额外媒体文件给: ${owner}`);
                        } catch (err) {
                            globalThis.print(`❌ [防撤回] 额外媒体发送给 ${owner} 失败: ${err.message}`);
                        }
                    }
                }
            }
            // 🌟 及时清理当前撤回的消息缓存，防止重复触发
            backupCache.delete(String(raw.message_id));
        }
    }
  }
};