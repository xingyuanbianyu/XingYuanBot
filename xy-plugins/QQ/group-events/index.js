// xy-plugins/QQ/group-events/index.js
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHARED_DB_PATH = path.resolve(__dirname, '../../plugins/event-settings/group_data.db');

let eventBrowser = null;
let browserLaunching = null;

function getTemplateConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '../../../temp/vris/vris.yaml'), 'utf-8');
    return yaml.parse(raw);
  } catch (e) { return {}; }
}

function getBotConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '../../../xy-data/config.yaml'), 'utf-8');
    const parsed = yaml.parse(raw) || {};
    return {
      blacklist_group: (parsed.blacklist_group || []).map(String),
      eventEnabled: parsed.group_events?.enabled !== false,
    };
  } catch (e) {
    return { blacklist_group: [], eventEnabled: true };
  }
}

// 🌟 直连数据库读取配置（加入强类型转换，防止 "0" 变成 true）
function getGroupSettings(groupId) {
    const gid = String(groupId);
    if (!fs.existsSync(SHARED_DB_PATH)) return null;
    
    let db = null;
    try {
        db = new Database(SHARED_DB_PATH, { readonly: true });
        const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='group_event_settings'`).get();
        if (!tableExists) {
            db.close();
            return null;
        }
        const row = db.prepare('SELECT welcome, decrease, kick FROM group_event_settings WHERE group_id = ?').get(gid);
        db.close();

        if (row) {
            // 🌟 核心修复：全部转成 Number，确保判断时类型绝对一致
            return { 
                welcome: Number(row.welcome), 
                decrease: Number(row.decrease), 
                kick: Number(row.kick) 
            };
        }
    } catch (e) {
        console.error(`❌ [群事件] 读取直连数据库异常: ${e.message}`);
        if (db && db.open) db.close();
    }
    return null;
}

function render(key, vars) {
  const tpl = getTemplateConfig()[key];
  if (!tpl) return null;
  let s = tpl;
  s = s.replace(/\{qq\}/g, String(vars.qq ?? '未知'));
  s = s.replace(/\{operator\}/g, String(vars.operator ?? '未知'));
  return s;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function generateEventImage(eventType, textMsg, qq) {
    let context = null;
    try {
        let chromium = null;
        try { chromium = (await import('playwright')).chromium; } catch (e) {
            try { chromium = (await import('puppeteer')).default || (await import('puppeteer')); } catch (e2) {}
        }
        if (!chromium) throw new Error("未安装浏览器渲染内核");

        if (!eventBrowser || !eventBrowser.isConnected()) {
            if (eventBrowser) {
                try { await eventBrowser.close(); } catch(e){}
                eventBrowser = null;
            }
            
            if (!browserLaunching) {
                browserLaunching = chromium.launch({ 
                    headless: true, 
                    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox', '--no-zygote'] 
                }).then(b => {
                    eventBrowser = b;
                    browserLaunching = null;
                    return b;
                }).catch(err => {
                    browserLaunching = null;
                    throw err;
                });
            }
            await browserLaunching;
        }

        let icon = '📢';
        let themeColor = '#2196F3'; 
        let bgGradient = 'linear-gradient(135deg, #1e1e24, #2b2b36)';
        
        if (eventType === 'welcome') {
            icon = '🎉'; themeColor = '#4CAF50'; bgGradient = 'linear-gradient(135deg, #1e241e, #2b362b)';
        } else if (eventType === 'decrease') {
            icon = '👋'; themeColor = '#FF9800'; bgGradient = 'linear-gradient(135deg, #241e1e, #362b2b)';
        } else if (eventType === 'kick') {
            icon = '🥾'; themeColor = '#F44336'; bgGradient = 'linear-gradient(135deg, #241a1a, #361f1f)';
        }

        const avatarUrl = qq && qq !== '未知' ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` : `https://q1.qlogo.cn/g?b=qq&nk=10000&s=640`;
        const htmlText = escapeHtml(textMsg).replace(/\n/g, '<br>');

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; display: inline-block; }
                .card { 
                    background: ${bgGradient}; 
                    border-radius: 20px; 
                    width: 480px; 
                    padding: 24px; 
                    border: 1px solid rgba(255, 255, 255, 0.08); 
                    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.4); 
                    position: relative;
                    overflow: hidden;
                }
                .card::before {
                    content: ''; position: absolute; top: -50px; left: -50px; width: 150px; height: 150px;
                    background: ${themeColor}; filter: blur(80px); opacity: 0.3; z-index: 0;
                }
                .content { 
                    position: relative; z-index: 1; 
                    display: flex; align-items: center; gap: 20px; 
                }
                .avatar-box {
                    flex-shrink: 0;
                    width: 76px; height: 76px;
                    border-radius: 50%;
                    padding: 3px;
                    background: rgba(255, 255, 255, 0.05);
                    border: 2px solid ${themeColor};
                    box-shadow: 0 0 15px ${themeColor}40;
                    position: relative;
                }
                .avatar-box img {
                    width: 100%; height: 100%;
                    border-radius: 50%;
                    object-fit: cover;
                    display: block;
                }
                .badge {
                    position: absolute; bottom: -5px; right: -5px;
                    background: #1e1e24;
                    border-radius: 50%; width: 28px; height: 28px;
                    display: flex; justify-content: center; align-items: center;
                    font-size: 16px; border: 1px solid rgba(255,255,255,0.1);
                }
                .text-box { flex: 1; display: flex; flex-direction: column; gap: 8px; }
                .title { 
                    font-size: 15px; color: #888; font-weight: 600; 
                    letter-spacing: 1px; display: flex; align-items: center; gap: 6px;
                }
                .title::before { content: ''; width: 4px; height: 14px; background: ${themeColor}; border-radius: 2px; }
                .message { 
                    font-size: 16px; color: #eee; line-height: 1.5; 
                    word-break: break-all; font-weight: 500;
                }
                .footer {
                    position: relative; z-index: 1;
                    margin-top: 20px; padding-top: 12px;
                    border-top: 1px dashed rgba(255, 255, 255, 0.1);
                    font-size: 12px; color: #666; text-align: right;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="content">
                    <div class="avatar-box">
                        <img src="${avatarUrl}" alt="avatar">
                        <div class="badge">${icon}</div>
                    </div>
                    <div class="text-box">
                        <div class="title">群事件提示</div>
                        <div class="message">${htmlText}</div>
                    </div>
                </div>
                <div class="footer">XingYuanBot 自动播报</div>
            </div>
        </body>
        </html>
        `;

        context = await eventBrowser.newContext({ deviceScaleFactor: 2, viewport: { width: 600, height: 800 } });
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        
        const cardElement = await page.$('.card');
        const buffer = await cardElement.screenshot({ type: 'png', omitBackground: true });
        
        return buffer;
    } catch (e) {
        console.error('❌ [群事件] 渲染图片失败，将降级为纯文本:', e.message);
        if (e.message.includes('Target page, context or browser has been closed') || e.message.includes('Connection closed')) {
            console.warn('⚠️ [群事件] 检测到浏览器异常关闭，正在重置实例...');
            if (eventBrowser) {
                try { await eventBrowser.close(); } catch(err){}
                eventBrowser = null;
            }
        }
        return null;
    } finally {
        if (context) {
            try { await context.close(); } catch (err) {}
        }
    }
}

function parseMessage(cqString) {
  const result = [];
  let lastIndex = 0;
  const regex = /\[CQ:(\w+),([^\]]*)\]/g;
  let match;

  while ((match = regex.exec(cqString)) !== null) {
    if (match.index > lastIndex) {
      result.push({ type: 'text', data: { text: cqString.slice(lastIndex, match.index) } });
    }
    const type = match[1];
    const data = {};
    match[2].split(',').forEach(item => {
      const eqIdx = item.indexOf('=');
      if (eqIdx === -1) return;
      data[item.slice(0, eqIdx)] = item.slice(eqIdx + 1);
    });
    result.push({ type, data });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < cqString.length) {
    result.push({ type: 'text', data: { text: cqString.slice(lastIndex) } });
  }

  return result.length > 0 ? result : [{ type: 'text', data: { text: cqString } }];
}

async function getGroupName(groupId, userId) {
  if (typeof globalThis.wsCall !== 'function') return null;
  try {
    const data = await globalThis.wsCall('get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: false
    });
    return data.data?.card || data.data?.nickname || null;
  } catch (e) { 
    return null; 
  }
}

export default {
  name: '群事件提示',
  events: ['group.increase', 'group.decrease', 'group.kick'],

  async onEvent(e, conn) {
    const botConfig = getBotConfig();
    if (!botConfig.eventEnabled) return;
    if (botConfig.blacklist_group.includes(String(e.groupId))) return;

    const groupSets = getGroupSettings(e.groupId);
    if (!groupSets) return; 

    const raw = e.raw || {};
    let key = '';
    
    // 🌟 核心修复：绝对精准的事件识别
    if (e.event === 'group.increase') {
        key = 'welcome';
    } else if (e.event === 'group.decrease' || e.event === 'group.kick') {
        if (raw.sub_type === 'kick' || e.event === 'group.kick') {
            key = 'kick';
        } else {
            key = 'decrease';
        }
    } else {
        return; // 不是这三种事件，直接干碎
    }

    // 🌟 核心修复：绝对严格的三项独立拦截（不是 1 就滚蛋）
    if (key === 'welcome' && groupSets.welcome !== 1) return;
    if (key === 'decrease' && groupSets.decrease !== 1) return;
    if (key === 'kick' && groupSets.kick !== 1) return;

    const targetQQ = String(e.userId || raw.target_id || raw.user_id || '未知');
    const operatorQQ = String(e.operatorId || raw.operator_id || '');

    let qqValue = targetQQ;
    let opValue = operatorQQ || '系统';

    let cachedMembers = [];
    if (typeof globalThis.getGroupMembers === 'function') {
        cachedMembers = globalThis.getGroupMembers(e.groupId) || [];
    }

    if (key === 'decrease' || key === 'kick') {
        qqValue = raw.nickname || raw.card || qqValue;
        
        const cachedUser = cachedMembers.find(m => String(m.user_id) === targetQQ);
        if (cachedUser) qqValue = cachedUser.card || cachedUser.nickname || qqValue;

        if (operatorQQ && operatorQQ !== '0') {
            opValue = raw.operator_nickname || raw.operator_card || opValue;
            const cachedOp = cachedMembers.find(m => String(m.user_id) === operatorQQ);
            if (cachedOp) opValue = cachedOp.card || cachedOp.nickname || opValue;
        }
    } else {
        const cachedUser = cachedMembers.find(m => String(m.user_id) === targetQQ);
        const cachedUserCard = cachedUser ? (cachedUser.card || cachedUser.nickname) : null;
        
        qqValue = raw.nickname || raw.card || cachedUserCard || await getGroupName(e.groupId, targetQQ) || targetQQ;
        
        if (operatorQQ && operatorQQ !== '0') {
            const cachedOp = cachedMembers.find(m => String(m.user_id) === operatorQQ);
            const cachedOpCard = cachedOp ? (cachedOp.card || cachedOp.nickname) : null;
            opValue = raw.operator_nickname || raw.operator_card || cachedOpCard || await getGroupName(e.groupId, operatorQQ) || operatorQQ;
        }
    }

    const msg = render(key, { qq: qqValue, operator: opValue });
    if (!msg) return;

    if (typeof globalThis.wsCall === 'function') {
        const imageBuffer = await generateEventImage(key, msg, targetQQ);

        try {
            if (imageBuffer) {
                await globalThis.wsCall('send_msg', {
                    message_type: 'group',
                    group_id: Number(e.groupId),
                    message: [{ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } }],
                });
                console.log(`✅ [${key}] → 群 ${e.groupId}: [图片卡片已发送]`);
            } else {
                await globalThis.wsCall('send_msg', {
                    message_type: 'group',
                    group_id: Number(e.groupId),
                    message: parseMessage(msg),
                });
                console.log(`✅ [${key}] → 群 ${e.groupId} (文本降级): ${msg}`);
            }
        } catch (err) {
            console.error(`❌ [群事件] 发送消息到群 ${e.groupId} 失败: ${err.message}`);
        }
    } else {
        console.error('❌ [群事件] wsCall 未就绪，无法发送消息');
    }
  },
};