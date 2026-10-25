import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const GLOBAL_CONFIG_PATH = path.resolve(__dirname, '../../../xy-config/config/config.yaml');

const DB_PATH = path.join(__dirname, 'anti_recall.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS exclusive_push (
    user_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL
  )
`);

const backupCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;

let recallBrowser = null;
let browserLaunching = null;

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
                    html += `<div class="img-box"><img src="${url}" /></div>`;
                } else if (url.startsWith('{')) {
                    try {
                        const json = JSON.parse(url);
                        if (json.url) html += `<div class="img-box"><img src="${json.url}" /></div>`;
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

  // 🌟 修复：更精准地获取所有类型的主人
  getOwners() {
    try {
      if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return [];
      const authConfig = yaml.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) || {};
      const ownersObj = authConfig.permissions?.owners || {};
      const permStatus = authConfig.permissions?.owner_permission || {};
      const validOwners = [];
      
      for (const [qq, val] of Object.entries(ownersObj)) {
          const qqStr = String(qq).trim();
          if (!qqStr) continue;
          
          if (val === true || val === 'true') {
              validOwners.push(qqStr); // 全局大主人
          } else if (Array.isArray(val)) {
              validOwners.push(qqStr); // 局部主人
          } else if (val === false) {
              // 全局小主人（看开关）
              if (String(permStatus[qqStr]) !== '0') validOwners.push(qqStr);
          }
      }
      return [...new Set(validOwners)];
    } catch (e) { return []; }
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
        const owners = this.getOwners();
        const isSenderOwner = owners.includes(senderQQ);
        if (!isSenderOwner) return '❌ 权限不足：仅主人可配置专属拦截。';

        if (cmd.startsWith('指定拦截')) {
            const content = cmd.replace('指定拦截', '').trim();
            const match = content.match(/^(\d{5,12})(?:\s+(\d{5,12}))?$/);
            if (!match) return '⚠️ 用法：\n指定拦截 QQ号 群号\n指定拦截 QQ号';
            const targetQQ = match[1];
            const targetGroup = match[2] || currentGroupId;
            if (!targetGroup) return '❌ 必须在群内使用，或者显式提供群号。';
            if (!owners.includes(targetQQ)) return `❌ 设置失败：${targetQQ} 不在主人列表中。`;

            db.prepare('INSERT OR REPLACE INTO exclusive_push (user_id, group_id) VALUES (?, ?)').run(targetQQ, targetGroup);
            return `✅ 设置成功！\n主人 ${targetQQ} 现在起【只接收群 ${targetGroup}】的撤回通知。`;
        }

        if (cmd.startsWith('取消拦截')) {
            const content = cmd.replace('取消拦截', '').trim();
            const match = content.match(/^(\d{5,12})$/);
            const targetQQ = match ? match[1] : senderQQ;
            if (!owners.includes(targetQQ)) return `❌ 失败：${targetQQ} 不在主人列表中。`;
            const info = db.prepare('DELETE FROM exclusive_push WHERE user_id = ?').run(targetQQ);
            return info.changes > 0 ? `✅ 已取消！主人 ${targetQQ} 恢复接收所有群的通知。` : `⚠️ 主人 ${targetQQ} 当前没有设置专属拦截。`;
        }

        if (cmd.startsWith('查看拦截')) {
            const rows = db.prepare('SELECT user_id, group_id FROM exclusive_push').all();
            if (rows.length === 0) return '⚙️ 当前没有任何主人设置专属拦截。';
            let reply = '⚙️ 当前专属拦截绑定列表：\n';
            rows.forEach(r => { reply += `👤 主人 ${r.user_id} ➡️ 只听群 ${r.group_id}\n`; });
            return reply.trim();
        }
    }

    // 缓存消息
    if (raw.post_type === 'message' && raw.message_id) {
        if (senderQQ === String(msg.botId)) return false;

        // 🌟 核心修复 1：强制 String 解决撤回时类型不匹配的问题
        backupCache.set(String(raw.message_id), {
            name: msg.senderName || '未知',
            senderId: senderQQ,
            groupId: currentGroupId,
            groupName: msg.isGroup ? (raw.group_name || null) : null,
            content: raw.message || [] 
        });
        
        globalThis.print(`[防撤回] 已缓存消息: ${raw.message_id}`);
        
        setTimeout(() => backupCache.delete(String(raw.message_id)), CACHE_TIME);
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
        // 🌟 核心修复 1：查缓存时强制 String
        const backup = backupCache.get(String(raw.message_id));
        
        if (backup) {
            globalThis.print(`\n[防撤回] 🚨 检测到撤回事件，正在提取缓存并私聊通知主人...`);
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

            const allOwners = this.getOwners();
            if (allOwners.length === 0) {
                globalThis.print(`[防撤回] ⚠️ 没有获取到主人列表，无法发送！请检查 ${GLOBAL_CONFIG_PATH}`);
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
                        await page.setContent(html, { waitUntil: 'networkidle' });
                        const cardElement = await page.$('.card');
                        imageBuffer = await cardElement.screenshot({ type: 'png', omitBackground: true });
                    } finally {
                        await browserContext.close().catch(()=>{});
                    }
                }
            } catch (err) {
                console.error('❌ [防撤回] 渲染图片失败，将降级为纯文本:', err.message);
            }

            const alertText = config.alert_text || '🛑 【防撤回拦截】\n';
            
            // 🌟 核心修复 2：将原始 CQ 数组强行转为纯文本，防止发出去红框报错
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

            const boundGroups = new Map();
            const rows = db.prepare('SELECT user_id, group_id FROM exclusive_push').all();
            rows.forEach(r => boundGroups.set(String(r.user_id), String(r.group_id)));

            for (const owner of allOwners) {
                if (owner === backup.senderId) continue;

                const boundGroup = boundGroups.get(String(owner));
                let shouldSend = false;

                if (boundGroup) {
                    if (currentGroupId === boundGroup) shouldSend = true;
                } else {
                    shouldSend = true;
                }

                if (shouldSend && typeof globalThis.wsCall === 'function') {
                    // 🌟 核心修复 3：加入 500ms 延迟和 15 秒超时，防止多主人并发把接口刷爆
                    await new Promise(r => setTimeout(r, 500));
                    try {
                        if (imageBuffer) {
                            await globalThis.wsCall('send_msg', {
                                message_type: 'private',
                                user_id: Number(owner),
                                message: [{ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } }]
                            }, 15000, ws);
                        } else {
                            await globalThis.wsCall('send_msg', {
                                message_type: 'private',
                                user_id: Number(owner),
                                message: fallbackMsg
                            }, 15000, ws);
                        }
                        globalThis.print(`[防撤回] ✅ 已成功发送给主人: ${owner}`);
                    } catch(err) {
                        globalThis.print(`❌ [防撤回] 发送给主人 ${owner} 失败: ${err.message}`);
                    }
                }
            }
            backupCache.delete(String(raw.message_id));
        }
    }
  }
};