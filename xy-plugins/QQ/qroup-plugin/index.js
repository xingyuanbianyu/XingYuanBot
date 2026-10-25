import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getRole } from '../../../xy-config/config/permissions.js';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_PATH = path.resolve(__dirname, '../../plugins/指令/menu.json');
const DB_PATH = path.resolve(__dirname, 'group_data.db'); 

// ==========================================
// 🌟 公共前缀剥离函数
// ==========================================
function stripPrefix(text) {
    let cmd = (text || "").trim();
    const dynamicPrefixes = ['/', '$', '#', '!', '。', '.'];
    for (const p of dynamicPrefixes) {
        if (cmd.startsWith(p)) { 
            cmd = cmd.slice(p.length).trim(); 
            break; 
        }
    }
    return cmd;
}

// 🌟 修复：sleep / random 兜底，防止主框架未挂载时崩溃
const sleepFn = globalThis.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
const randomFn = globalThis.random || ((min, max) => Math.floor(Math.random() * (max - min + 1)) + min);

// 初始化数据库表
if (typeof globalThis.db === 'function') {
    globalThis.db('exec', { dbPath: DB_PATH, sql: 'CREATE TABLE IF NOT EXISTS like_records (user_id TEXT PRIMARY KEY, last_like_cycle TEXT NOT NULL)' });
    globalThis.db('exec', { dbPath: DB_PATH, sql: 'CREATE TABLE IF NOT EXISTS group_ban_settings (group_id TEXT PRIMARY KEY, auto_ban INTEGER DEFAULT 1)' });
    globalThis.db('exec', { 
        dbPath: DB_PATH,
        sql: `CREATE TABLE IF NOT EXISTS group_reject_list (
            group_id TEXT, 
            user_id TEXT, 
            nickname TEXT,
            create_time INTEGER,
            PRIMARY KEY(group_id, user_id)
        )` 
    });
    try { globalThis.db('exec', { dbPath: DB_PATH, sql: 'ALTER TABLE group_reject_list ADD COLUMN nickname TEXT' }); } catch (e) {}
    try { globalThis.db('exec', { dbPath: DB_PATH, sql: 'ALTER TABLE group_reject_list ADD COLUMN create_time INTEGER' }); } catch (e) {}
}

function getCurrentLikeCycle() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

let botConfig = {};
try {
    const yamlPath = path.join(__dirname, '../../../xy-config/config/bot.yaml');
    botConfig = parseYaml(fs.readFileSync(yamlPath, 'utf8')) || {};
} catch (e) {}

// ==========================================
// 🌟 修复：Bot 权限缓存 + ws 参数
// ==========================================
const botRoleCache = new Map(); // groupId -> { role, time }

async function checkBotRole(chatId, ws) {
    if (typeof globalThis.wsCall !== 'function') return false;
    const gid = String(chatId);
    
    const cached = botRoleCache.get(gid);
    if (cached && Date.now() - cached.time < 60000) {
        return cached.role === 'owner' || cached.role === 'admin';
    }
    
    try {
        const botQQ = globalThis.botInfo?.qq || (await globalThis.wsCall('get_login_info', {}, 3000, ws))?.data?.user_id;
        if (!botQQ) return false;
        const data = await globalThis.wsCall('get_group_member_info', { 
            group_id: Number(chatId), user_id: Number(botQQ), no_cache: true 
        }, 3000, ws);
        const role = data?.data?.role || 'member';
        botRoleCache.set(gid, { role, time: Date.now() });
        return role === 'owner' || role === 'admin';
    } catch (e) {
        return false;
    }
}

const myCommands = [
  { cmd: '随机抽人 [数量] [指令]', desc: '随机抽取成员，可附带指令。支持 {QQ} 或 @ 占位符' },
  { cmd: '查询群黑名单', desc: '查看本群自定义的黑名单（退群/被踢的人都在这里）' },
  { cmd: '拉黑群成员@成员', desc: '手动将某人加入本群黑名单' },
  { cmd: '解除拉黑@成员', desc: '将某人从本群黑名单中移除（支持输入QQ号）' },
  { cmd: '踢@成员', desc: '将指定成员踢出群聊并强制拉黑' },
  { cmd: '禁言@成员QQ号 秒', desc: '禁言指定成员，默认600秒' },
  { cmd: '解禁@QQ号', desc: '解除指定成员的禁言' },
  { cmd: '头衔 内容 / 申请头衔 内容', desc: '给自己设置专属头衔' },
  { cmd: '设置管理@成员', desc: '将指定成员设为管理员（需大主人）' },
  { cmd: '取消管理@成员', desc: '将指定成员降为普通成员（需大主人）' },
  { cmd: '点赞 / 赞我', desc: '让机器人给你点赞（每天0点重置）' },
  { cmd: '赞他@成员 / @成员 赞他', desc: '让机器人给指定成员点赞' },
  { cmd: '改头衔 [@成员] 内容', desc: '让群主机器人改其他人的头衔'},
  { cmd: '群公告 内容', desc: '发布群公告'},
  { cmd: '查公告', desc: '查看本群的历史公告及ID'},
  { cmd: '删公告 [ID]', desc: '删除指定的群公告' },
  { cmd: '批量移出', desc: '批量移出群成员' },
  { cmd: '查等级 [等级]', desc: '查看群成员等级统计' },
  { cmd: '查潜水 [天数]', desc: '查看超过指定天数未发言的成员' },
  { cmd: '清理潜水 [天数] -y', desc: '清理潜水成员' }
];

function injectHelp() {
  if (!fs.existsSync(MENU_PATH)) return;
  try {
    let menu = JSON.parse(fs.readFileSync(MENU_PATH, 'utf-8'));
    if (!menu.commands) menu.commands = {};
    if (!menu.categories) menu.categories = [];

    let maxId = Math.max(0, ...Object.keys(menu.commands).map(k => parseInt(k) || 0));
    const existingCmds = Object.values(menu.commands).map(v => v.cmd);
    const newAddedIds = [];

    for (const item of myCommands) {
        if (!existingCmds.includes(item.cmd)) {
            maxId++;
            menu.commands[maxId] = { cmd: item.cmd, desc: item.desc };
            newAddedIds.push(maxId);
        }
    }

    if (newAddedIds.length === 0) return;

    let groupManageCategory = menu.categories.find(c => c.name === '群管');
    if (groupManageCategory) {
        groupManageCategory.items = [...new Set([...groupManageCategory.items, ...newAddedIds])];
    } else {
        menu.categories.push({
            name: '群管',
            description: '群管理（管理员及以上可用）',
            color: '#459c5f',
            items: newAddedIds
        });
    }

    menu.version = (menu.version || 0) + 1;
    fs.writeFileSync(MENU_PATH, JSON.stringify(menu, null, 4), 'utf-8');
  } catch (e) {}
}
injectHelp();

function parseText(text) {
  if (Array.isArray(text)) return text.map(item => item?.data?.text ? item.data.text : '').join('');
  if (typeof text === 'object' && text != null && text.text !== undefined) return text.text;
  return String(text || '');
}

// 🌟 修复：sendForwardMsg 全链路带 ws
async function sendForwardMsg(chatId, isGroup, title, msgList, ws) {
    if (typeof globalThis.wsCall !== 'function') return false;
    const nodes = msgList.map(m => ({
        type: 'node',
        data: { name: title, uin: String(globalThis.botInfo?.qq || 10000), content: [{ type: 'text', data: { text: m } }] }
    }));
    const action = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
    const params = { ...(isGroup ? { group_id: Number(chatId) } : { user_id: Number(chatId) }), messages: nodes };
    try {
        await globalThis.wsCall(action, params, 10000, ws);
        return true;
    } catch (e) { 
        return false; 
    }
}

export default {
  name: '群管',
  description: '群管工具箱',
  events: ['group.decrease', 'group.kick', 'group.request'],

  // 🌟 修复：严格锚定匹配，防止群友聊天误触
  match: (text) => {
    if (!text || typeof text !== 'string') return false;
    const cmd = stripPrefix(text);
    if (cmd.includes('添加定时') || cmd.includes('查看定时') || cmd.includes('删除定时')) return false;
    
    if (/^(随机抽人|踢|禁言|解禁|头衔|申请头衔|改头衔|设置管理|取消管理|群公告|查公告|删公告|批量移出|查等级|查潜水|清理潜水|查询群黑名单|拉黑群成员|解除拉黑|赞我|点赞)(\s|$)/.test(cmd)) return true;
    if (/赞(他|她)/.test(cmd) && cmd.length < 30) return true;
    return false;
  },

  // 🌟 修复：onEvent 补 ws
  async onEvent(e, context) {
      const groupId = String(e.groupId);
      if (typeof globalThis.db !== 'function') return;

      const raw = e.raw || {};
      const selfId = String(e.selfId || raw.self_id || '');
      let ws = context?.ws;
      if (!ws && selfId && globalThis.sharedState?.botIdToWs) {
          ws = globalThis.sharedState.botIdToWs.get(selfId);
      }
      if (!ws) ws = globalThis.activeWs;

      if (e.event === 'group.decrease' || e.event === 'group.kick') {
          const userId = String(e.userId || raw.target_id || raw.user_id); 
          if (!userId || userId === 'undefined' || userId === String(globalThis.botInfo?.qq)) return;
          
          const res = globalThis.db('find', { dbPath: DB_PATH, table: 'group_ban_settings', where: 'group_id = ?', params: [groupId], all: false });
          if (!res.data || res.data.auto_ban === 1) {
              let nick = raw.nickname || raw.card;
              
              if (!nick && typeof globalThis.getGroupMembers === 'function') {
                  const cachedMembers = globalThis.getGroupMembers(groupId) || [];
                  const cachedUser = cachedMembers.find(m => String(m.user_id) === userId);
                  if (cachedUser) nick = cachedUser.card || cachedUser.nickname;
              }

              if (!nick && typeof globalThis.wsCall === 'function') {
                  try {
                      const infoData = await globalThis.wsCall('get_stranger_info', { user_id: Number(userId) }, 3000, ws);
                      if (infoData?.data) nick = infoData.data.nickname;
                  } catch(err) {}
              }
              
              nick = nick || '未知昵称';

              globalThis.db('exec', {
                  dbPath: DB_PATH,
                  sql: 'INSERT OR REPLACE INTO group_reject_list (group_id, user_id, nickname, create_time) VALUES (?, ?, ?, ?)',
                  params: [groupId, userId, nick, Math.floor(Date.now() / 1000)]
              });
          }
      }

      if (e.event === 'group.request') {
          const userId = String(e.userId);
          const flag = e.raw?.flag;
          const subType = e.raw?.sub_type;
          const checkRes = globalThis.db('find', { dbPath: DB_PATH, table: 'group_reject_list', where: 'group_id = ? AND user_id = ?', params: [groupId, userId], all: false });

          if (checkRes.success && checkRes.data && typeof globalThis.wsCall === 'function') {
              try {
                  await globalThis.wsCall('set_group_add_request', { flag: flag, sub_type: subType, approve: false, reason: '您已被本群拉黑，拒绝加入。' }, 3000, ws);
              } catch (err) {}
          }
      }
  },

  handle: async function({ text, pureText, chatId, isGroup, senderName, senderQQ, role, _ws }) {
    if (!text) return false;
    
    const ws = _ws; // 🌟 统一使用
    const cmd = stripPrefix(pureText || "");
    if (!cmd) return false;
    
    let textStr = parseText(text).trim();

    let isGroupAdmin = false;
    if (typeof globalThis.wsCall === 'function') {
        try {
            const cachedMembers = globalThis.getGroupMembers ? globalThis.getGroupMembers(chatId) : [];
            const cachedUser = cachedMembers.find(m => String(m.user_id) === String(senderQQ));
            if (cachedUser && ['owner', 'admin'].includes(cachedUser.role)) {
                isGroupAdmin = true;
            } else {
                const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(chatId), user_id: Number(senderQQ) }, 3000, ws);
                const rawRole = res?.data?.role;
                if (rawRole === 'owner' || rawRole === 'admin') isGroupAdmin = true;
            }
        } catch (e) {}
    }
    
    const configAdmin = ['master', 'owner', 'admin'];
    const realRole = (typeof getRole === 'function') ? getRole(senderQQ) : role;
    let hasPermission = isGroupAdmin || configAdmin.includes(realRole);
    const isMaster = (realRole === 'master');

    // ==========================================
    // 随机抽人
    // ==========================================
    if (cmd.startsWith('随机抽人')) {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        let restCmd = cmd.replace(/^随机抽人\s*/, '').trim();
        let count = 1; 
        let actionCmd = restCmd;

        const countMatch = restCmd.match(/^(\d+)\s*(.*)$/);
        if (countMatch) { count = parseInt(countMatch[1]); actionCmd = countMatch[2].trim(); }

        actionCmd = actionCmd.replace(/^[#\/$]+/, '').trim();
        if (count <= 0) return '⚠️ 抽取人数必须大于 0';

        let template = actionCmd;
        if (!template.includes('{QQ}') && !template.includes('@')) template = `${template} {QQ}`;
        else template = template.replace(/@/g, '{QQ}');
        const textParts = template.split('{QQ}');

        try {
            const data = await globalThis.wsCall('get_group_member_list', { group_id: Number(chatId) }, 10000, ws);
            let rawMembers = data?.data || [];
            let memberMap = new Map();
            for (const m of rawMembers) { if (m.user_id && m.user_id !== '0') memberMap.set(String(m.user_id), m); }
            let members = Array.from(memberMap.values());
            if (members.length === 0) return '❌ 无法获取群成员列表。';

            let winners = [];
            if (members.length <= count) { winners = members; } 
            else {
                let pool = [...members];
                for (let i = 0; i < count; i++) {
                    const randIndex = randomFn(0, pool.length - 1);
                    winners.push(pool[randIndex]);
                    pool.splice(randIndex, 1); 
                }
            }

            if (!actionCmd) {
                let atSegments = [{ type: 'text', data: { text: `🎲 抽取完毕！(群总人数: ${members.length})\n本次抽中的幸运儿是：\n` } }];
                winners.forEach(w => {
                    atSegments.push({ type: 'at', data: { qq: String(w.user_id) } });
                    atSegments.push({ type: 'text', data: { text: ` ` } });
                });
                return atSegments;
            }

            let usedPrefix = '#';
            for (const p of ['#', '/', '$', '!', '！', '。', '.']) {
                if (cmd.startsWith(p)) { usedPrefix = p; break; }
            }

            // 🌟 关键修复：try...finally 保证 bot.send 一定恢复
            (async () => {
                let successCount = 0;
                let collectedNodes = []; 
                const originalSend = globalThis.bot.send;
                
                try {
                    globalThis.bot.send = async (m) => {
                        if (m.content && (m.content.includes('随机抽人回调启动') || m.content.includes('所有查询执行完毕'))) {
                            return originalSend(m);
                        }
                        if (String(m.chatId) === String(chatId) && m.isGroup && typeof m.content === 'string') {
                            collectedNodes.push({
                                type: 'node',
                                data: {
                                    name: '执行结果',
                                    uin: String(globalThis.botInfo?.qq || 10000),
                                    content: [{ type: 'text', data: { text: m.content } }]
                                }
                            });
                            return; 
                        }
                        return originalSend(m);
                    };

                    for (let i = 0; i < winners.length; i++) {
                        const w = winners[i];
                        try {
                            let fakeMessageSegments = [];
                            let rawMessageText = '';
                            for (let j = 0; j < textParts.length; j++) {
                                if (textParts[j]) {
                                    fakeMessageSegments.push({ type: 'text', data: { text: textParts[j] } });
                                    rawMessageText += textParts[j];
                                }
                                if (j < textParts.length - 1) {
                                    fakeMessageSegments.push({ type: 'at', data: { qq: String(w.user_id) } });
                                    rawMessageText += `@${w.user_id}`;
                                }
                            }
                            const fakeMsgData = {
                                time: Math.floor(Date.now() / 1000), self_id: Number(globalThis.botInfo?.qq || 10000), 
                                post_type: "message", message_type: "group", sub_type: "normal", message_id: Math.floor(Math.random() * 10000000),
                                group_id: Number(chatId), user_id: Number(senderQQ), raw_message: `${usedPrefix}${rawMessageText}`, font: 0,
                                sender: { user_id: Number(senderQQ), nickname: senderName, card: senderName, role: role },
                                message: [{ type: 'text', data: { text: usedPrefix } }, ...fakeMessageSegments]
                             };
                            if (typeof globalThis.handleIncomingMessage === 'function' && globalThis.activeWs) {
                                globalThis.handleIncomingMessage(JSON.stringify(fakeMsgData), ws || globalThis.activeWs, globalThis._registry, globalThis._plugins);
                                successCount++;
                            }
                        } catch (e) {}
                        await sleepFn(1500); 
                    }

                    await sleepFn(1000);
                } finally {
                    // 🌟 无论如何都要恢复，否则整个 Bot 崩溃
                    globalThis.bot.send = originalSend;
                }

                if (collectedNodes.length > 0) {
                    const chunkSize = 20;
                    let sendSuccess = 0;
                    for (let i = 0; i < collectedNodes.length; i += chunkSize) {
                        const chunk = collectedNodes.slice(i, i + chunkSize);
                        try {
                            await globalThis.wsCall('send_group_forward_msg', { group_id: Number(chatId), messages: chunk }, 10000, ws);
                            sendSuccess++;
                            await sleepFn(500);
                        } catch (err) {
                            globalThis.print(`[随机抽人] 合并消息发送失败: ${err.message}`);
                        }
                    }
                    if (sendSuccess > 0) {
                        globalThis.bot.send({ chatId, isGroup, content: `✅ 全部执行完毕，共打包了 ${collectedNodes.length} 条执行记录。`, botId: globalThis.botInfo?.qq, _ws: ws });
                    }
                } else {
                    globalThis.bot.send({ chatId, isGroup, content: `❌ 没有任何插件返回结果，可能是前置条件不满足。`, botId: globalThis.botInfo?.qq, _ws: ws });
                }

                globalThis.print(`[群管] 随机抽人回调执行完毕，成功静默处理 ${successCount}/${winners.length} 人。`);
            })();

            let names = winners.map(w => w.card || w.nickname || '神秘人');
            let tipMsg = `🎲 随机抽人回调启动！\n✨ 抽中人数：${winners.length} 人\n🔗 执行模板：${template.replace(/{QQ}/g, '@抽中者')}\n`;
            if (winners.length > 5) tipMsg += `(名单: ${names.slice(0, 5).join(', ')} 等 ${winners.length} 人...)\n`;
            else tipMsg += `(名单: ${names.join(', ')})\n`;
            tipMsg += `⏳ 正在后台匀速派发，所有返回结果将合并为消息发送。`;
            return tipMsg;
        } catch (e) { return `❌ 随机抽人失败: ${e.message}`; }
    }

    // ==========================================
    // 查询群黑名单
    // ==========================================
    if (cmd === '查询群黑名单') {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        if (!hasPermission) return '❌ 权限不足。';
        if (typeof globalThis.db !== 'function') return '❌ 数据库未挂载。';

        const res = globalThis.db('find', { dbPath: DB_PATH, table: 'group_reject_list', where: 'group_id = ?', params: [String(chatId)] });
        if (!res.success || !res.data || res.data.length === 0) return '📭 本群的数据库黑名单为空。';

        const formatRow = (row) => {
            const displayName = (row.nickname && row.nickname !== 'undefined' && row.nickname !== 'null') ? row.nickname : '未知昵称';
            let dateStr = '未知时间';
            if (row.create_time) {
                const timestamp = row.create_time < 10000000000 ? row.create_time * 1000 : row.create_time;
                const d = new Date(timestamp);
                if (!isNaN(d.getTime())) dateStr = d.toLocaleString('zh-CN');
            }
            return { name: displayName, date: dateStr, qq: row.user_id };
        };

        if (res.data.length > 5) {
            let msgList = [];
            res.data.forEach((row, index) => {
                const info = formatRow(row);
                msgList.push(`[${index + 1}] ${info.name} (${info.qq})\n拉黑时间: ${info.date}`);
            });
            msgList.unshift(`🛑 本群数据库黑名单（共 ${res.data.length} 人）`);
            if (await sendForwardMsg(chatId, isGroup, '群黑名单查询', msgList, ws)) return true;
        }

        let reply = `🛑 本群数据库黑名单（共 ${res.data.length} 人）：\n\n`;
        res.data.forEach((row, index) => {
            const info = formatRow(row);
            reply += `${index + 1}. ${info.name} (${info.qq})\n   拉黑时间: ${info.date}\n`;
        });
        reply += `\n💡 发送：解除拉黑 [QQ号] 可移出黑名单。`;
        return reply.trim();
    }

    // ==========================================
    // 手动拉黑 / 解除拉黑
    // ==========================================
    if (cmd.startsWith('拉黑群成员') || cmd.startsWith('解除拉黑')) {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        if (!hasPermission) return '❌ 权限不足。';
        
        let targetQQ = null;
        if (Array.isArray(text)) {
            const atItem = text.find(item => item?.type === 'at');
            if (atItem && atItem.data) targetQQ = String(atItem.data.qq || atItem.data.target);
        }
        if (!targetQQ) {
            const match = textStr.match(/@([^\s]+)/) || textStr.match(/(?<!\d)(\d{5,12})(?!\d)/);
            if (match) targetQQ = match[1];
        }
        if (!targetQQ) return `⚠️ 用法：${cmd.startsWith('拉黑') ? '拉黑群成员 @某人' : '解除拉黑 [QQ号]'}`;

        if (typeof globalThis.db === 'function') {
            if (cmd.startsWith('拉黑群成员')) {
                let nick = '手动拉黑';
                if (typeof globalThis.getGroupMembers === 'function') {
                    const cachedMembers = globalThis.getGroupMembers(chatId) || [];
                    const cachedUser = cachedMembers.find(m => String(m.user_id) === targetQQ);
                    if (cachedUser) nick = cachedUser.card || cachedUser.nickname || nick;
                }
                globalThis.db('exec', {
                    dbPath: DB_PATH,
                    sql: 'INSERT OR REPLACE INTO group_reject_list (group_id, user_id, nickname, create_time) VALUES (?, ?, ?, ?)',
                    params: [String(chatId), targetQQ, nick, Math.floor(Date.now() / 1000)]
                });
                return `✅ 已将 ${targetQQ} 加入本群数据库黑名单。`;
            } else {
                globalThis.db('exec', {
                    dbPath: DB_PATH,
                    sql: 'DELETE FROM group_reject_list WHERE group_id = ? AND user_id = ?',
                    params: [String(chatId), targetQQ]
                });
                return `✅ 已将 ${targetQQ} 从本群数据库黑名单中移除。`;
            }
        }
    }

    // ==========================================
    // 提取目标QQ
    // ==========================================
    let targetQQ = null;
    let targetName = null;
    
    if (Array.isArray(text)) {
        const atItem = text.find(item => item?.type === 'at');
        if (atItem && atItem.data && (atItem.data.qq || atItem.data.target)) {
            targetQQ = String(atItem.data.qq || atItem.data.target);
        }
    }
    
    if (!targetQQ) {
        const cqMatch = textStr.match(/\[CQ:at,qq=(\d+)\]/); 
        if (cqMatch) {
            targetQQ = cqMatch[1];
        } else {
            const match = textStr.match(/@([^\s]+)/) || textStr.match(/(?<!\d)(\d{5,12})(?!\d)/);
            if (match) targetQQ = match[1];
        }
    }

    if (!targetQQ) {
        const match = textStr.match(/@([^\s]+)/) || textStr.match(/(?<!\d)(\d{5,12})(?!\d)/);
        if (match) {
            const keyword = match[1];
            if (typeof globalThis.wsCall === 'function') {
                try {
                    const data = await globalThis.wsCall('get_group_member_list', { group_id: Number(chatId) }, 10000, ws);
                    const members = data?.data || [];
                    const found = members.find(m => String(m.user_id) === keyword || (m.nickname && m.nickname.includes(keyword)) || (m.card && m.card.includes(keyword)));
                    if (found) { targetQQ = String(found.user_id); targetName = found.card || found.nickname; }
                } catch (e) {}
            }
        }
    }

    // ==========================================
    // 踢人 / 禁言 / 解禁
    // ==========================================
    if (cmd.startsWith('踢') || cmd.startsWith('禁言') || cmd.startsWith('解禁')) {
        if (!targetQQ) return `⚠️ 用法：${cmd.split(' ')[0]}@成员`;
        if (!hasPermission) return '❌ 权限不足。';
        if (!(await checkBotRole(chatId, ws))) return '❌ 操作失败：Bot 不是管理员或群主，无法执行该操作。';

        if (cmd.startsWith('踢')) {
            try {
                const result = await globalThis.wsCall('set_group_kick', { group_id: Number(chatId), user_id: Number(targetQQ), reject_add_request: true }, 5000, ws);
                if (result.status === 'ok' || result.retcode === 0) {
                    if (typeof globalThis.db === 'function') {
                        const dbRes = globalThis.db('exec', { 
                            dbPath: DB_PATH, 
                            sql: 'INSERT OR REPLACE INTO group_reject_list (group_id, user_id, nickname, create_time) VALUES (?, ?, ?, ?)', 
                            params: [String(chatId), targetQQ, targetName || '被踢出', Math.floor(Date.now() / 1000)] 
                        });
                        if (!dbRes.success) return `✅ 已成功踢出，但记入黑名单失败: ${dbRes.error}`;
                    }
                    return `✅ 已成功踢出，并已记入本群黑名单。`;
                }
                return `❌ 踢人失败：${result.msg || result.message}`;
            } catch (err) { return `❌ 请求失败：${err.message}`; }
        }

        if (cmd.startsWith('禁言')) {
            let duration = 600; 
            const durationMatch = cmd.replace(targetQQ, "").match(/(\d+)\s*(s|秒|m|分钟|min|h|小时|d|天|日)?/i);
            if (durationMatch) {
                const value = parseInt(durationMatch[1]);
                const unit = (durationMatch[2] || 'm').toLowerCase();
                duration = unit.includes('s') || unit.includes('秒') ? value : unit.includes('h') || unit.includes('时') ? value * 3600 : unit.includes('d') || unit.includes('天') ? value * 86400 : value * 60;
            }
            try {
                const result = await globalThis.wsCall('set_group_ban', { group_id: Number(chatId), user_id: Number(targetQQ), duration: duration }, 5000, ws);
                if (cmd.includes('@') && cmd.includes('禁言')) return true; 
                return (result.status === 'ok' || result.retcode === 0) ? `✅ 已禁言 @${targetQQ} ${duration}秒` : `❌ 禁言失败：${result.msg || result.message}`;
            } catch (e) { return `❌ 禁言失败：${e.message}`; }
        }

        if (cmd.startsWith('解禁')) {
            try {
                const result = await globalThis.wsCall('set_group_ban', { group_id: Number(chatId), user_id: Number(targetQQ), duration: 0 }, 5000, ws);
                return (result.status === 'ok' || result.retcode === 0) ? `✅ 已成功解除禁言` : `❌ 解禁失败：${result.msg || result.message}`;
            } catch (err) { return `❌ 请求失败：${err.message}`; }
        }
    }

    // ==========================================
    // 查等级
    // ==========================================
    if (cmd.startsWith('查等级')) {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        if (!hasPermission) return '❌ 权限不足：仅限管理员及以上身份使用。';
        
        const targetLevel = cmd.split(/\s+/)[1];
        
        try {
            const data = await globalThis.wsCall('get_group_member_list', { group_id: Number(chatId) }, 10000, ws);
            if (!data || (data.status !== 'ok' && data.retcode !== 0)) {
                return `❌ 获取群成员列表失败: ${data?.msg || data?.message || '接口未返回数据，可能是群过大导致超时'}`;
            }

            let rawMembers = data?.data || [];
            let memberMap = new Map();
            for (const m of rawMembers) { 
                if (m.user_id && m.user_id !== '0') memberMap.set(String(m.user_id), m); 
            }
            let members = Array.from(memberMap.values());
            if (members.length === 0) return '❌ 无法获取群成员列表，群内可能没有有效成员数据。';
            
            if (targetLevel) {
                const filtered = members.filter(m => {
                    let lvl = m.level;
                    if (!lvl || lvl === '0' || lvl === 0 || parseInt(lvl) < 1) lvl = '1';
                    return String(lvl) === String(targetLevel);
                });
                if (filtered.length === 0) return `📊 本群没有等级为 Lv.${targetLevel} 的成员。`;
                
                if (filtered.length > 10) {
                    let msgList = [];
                    filtered.forEach((m, index) => { msgList.push(`${index + 1}. ${m.card || m.nickname || '未知昵称'} (${m.user_id})`); });
                    msgList.unshift(`📊 本群等级为 Lv.${targetLevel} 的成员共有 ${filtered.length} 人：`);
                    if (await sendForwardMsg(chatId, isGroup, `查等级 Lv.${targetLevel}`, msgList, ws)) return true;
                }

                let levelText = `📊 本群等级为 Lv.${targetLevel} 的成员共有 ${filtered.length} 人：\n`;
                filtered.slice(0, 50).forEach((m, index) => { levelText += `${index + 1}. ${m.card || m.nickname || '未知昵称'} (${m.user_id})\n`; });
                if (filtered.length > 50) levelText += `...（仅显示前 50 人）\n`;
                return levelText.trim();
            } else {
                const levelCount = {};
                for (const m of members) {
                    let lvl = m.level;
                    if (!lvl || lvl === '0' || lvl === 0 || parseInt(lvl) < 1) lvl = '1';
                    levelCount[lvl] = (levelCount[lvl] || 0) + 1;
                }
                let levelText = `📊 本群成员等级统计（共 ${members.length} 人）：\n`;
                for (const lvl of Object.keys(levelCount).sort((a, b) => parseInt(b) - parseInt(a))) { 
                    levelText += `Lv.${lvl} : ${levelCount[lvl]} 人\n`; 
                }
                return levelText.trim() + `\n💡 提示：发送“查等级 1”可查看具体成员。`;
            }
        } catch (e) { 
            return `❌ 查询等级异常: ${e.message}`; 
        }
    }

    // ==========================================
    // 查潜水 / 清理潜水
    // ==========================================
    if (cmd.startsWith('查潜水') || cmd.startsWith('清理潜水')) {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        const isClean = cmd.startsWith('清理潜水');
        const days = parseInt(cmd.split(/\s+/)[1]) || 30;
        if (isClean && !cmd.includes('-y')) return `⚠️ 危险操作！如需清理，请发送：清理潜水 ${days} -y`;
        if (isClean && !(await checkBotRole(chatId, ws))) return '❌ 操作失败：Bot 不是管理员或群主，无法清理成员。';

        try {
            const data = await globalThis.wsCall('get_group_member_list', { group_id: Number(chatId) }, 15000, ws);
            let rawMembers = data?.data || [];
            let memberMap = new Map();
            for (const m of rawMembers) { if (m.user_id && m.user_id !== '0') memberMap.set(String(m.user_id), m); }
            let members = Array.from(memberMap.values());
            
            const loginData = await globalThis.wsCall('get_login_info', {}, 3000, ws);
            const botQQ = loginData?.data?.user_id;

            const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
            let silentMembers = members.filter(m => m.role !== 'owner' && m.role !== 'admin' && m.user_id != botQQ && (m.last_sent_time || m.join_time) * 1000 < threshold);
            
            if (silentMembers.length === 0) return `✅ 没有超过 ${days} 天未发言的普通成员。`;
            silentMembers.sort((a, b) => (a.last_sent_time || a.join_time) - (b.last_sent_time || b.join_time));
            
            if (!isClean && silentMembers.length > 10) {
                let msgList = [];
                silentMembers.forEach((m, index) => { msgList.push(`${index + 1}. ${m.card || m.nickname} (${m.user_id})`); });
                msgList.unshift(`📊 超过 ${days} 天未发言的成员共 ${silentMembers.length} 人：\n若要清理，请发送：清理潜水 ${days} -y`);
                if (await sendForwardMsg(chatId, isGroup, `潜水成员名单`, msgList, ws)) return true;
            }

            const listText = silentMembers.slice(0, 50).map(m => `${m.card || m.nickname} (${m.user_id})`).join('\n');
            let resultMsg = `📊 超过 ${days} 天未发言的成员共 ${silentMembers.length} 人：\n${listText}\n`;
            if (silentMembers.length > 50) resultMsg += `...（仅显示前 50 人）\n`;
            if (!isClean) return resultMsg + `\n⚠️ 若要清理他们，请发送：清理潜水 ${days} -y`;
            if (!hasPermission) return '❌ 权限不足。';
            
            // 🌟 关键修复：改为异步执行，不阻塞主线程
            (async () => {
                let s = 0, f = 0;
                for (const m of silentMembers) {
                    await sleepFn(400);
                    try {
                        const k = await globalThis.wsCall('set_group_kick', { group_id: Number(chatId), user_id: Number(m.user_id), reject_add_request: true }, 5000, ws);
                        if (k.status === 'ok' || k.retcode === 0) s++; else f++;
                    } catch (_) { f++; }
                }
                globalThis.bot.send({ 
                    chatId, isGroup: true, 
                    content: `✅ 潜水清理完毕！成功 ${s} 人，失败 ${f} 人。`,
                    botId: globalThis.botInfo?.qq,
                    _ws: ws
                });
            })();

            return resultMsg + `\n🚀 清理任务已在后台执行，请稍候关注结果播报。`;
        } catch (e) { return `❌ 查询或清理失败: ${e.message}`; }
    }

    // ==========================================
    // 点赞
    // ==========================================
    if (cmd === '点赞' || cmd === '赞' || cmd === '赞我' || cmd.includes('赞他') || cmd.includes('赞她')) {
        let likeTargetQQ = senderQQ; 
        let isLikeOther = cmd.includes('赞他') || cmd.includes('赞她');
        let isSilent = cmd.includes('-s');
        
        if (isLikeOther) {
            if (!targetQQ) {
                const numMatch = textStr.match(/(\d{5,12})/);
                if (numMatch) targetQQ = numMatch[1];
            }
            if (!targetQQ) return '⚠️ 未找到该成员，请真实艾特（@）对方，或者确认对方在群里。';
            likeTargetQQ = targetQQ;
        }
        
        const currentCycle = getCurrentLikeCycle();
        if (!isLikeOther && typeof globalThis.db === 'function') {
            const dbRes = globalThis.db('find', { dbPath: DB_PATH, table: 'like_records', where: 'user_id = ?', params: [String(senderQQ)], all: false });
            if (dbRes.success && dbRes.data && dbRes.data.last_like_cycle === currentCycle) return `今天已经给自己点过赞啦，明天 0 点后再来吧~`;
        }
        if (botConfig.bot && botConfig.bot.likeEnabled === false) return '❌ 点赞功能已关闭';
        let isFriend = false;
        try {
            const friendData = await globalThis.wsCall('get_friend_list', {}, 5000, ws);
            const friends = friendData?.data || [];
            if (friends.some(f => f.user_id == likeTargetQQ)) isFriend = true;
        } catch (e) {}
        const times = isFriend ? 10 : 50;
        const loops = Math.ceil(times / 10);
        for (let i = 0; i < loops; i++) {
            try { await globalThis.wsCall('send_like', { user_id: Number(likeTargetQQ), times: 10 }, 5000, ws); } catch (e) {}
        }
        if (!isLikeOther && typeof globalThis.db === 'function') {
            globalThis.db('exec', { dbPath: DB_PATH, sql: 'INSERT OR REPLACE INTO like_records (user_id, last_like_cycle) VALUES (?, ?)', params: [String(senderQQ), currentCycle] });
        }
        if (isLikeOther) {
            if (isSilent) return true;
            if (!targetName) {
                try {
                    const memData = await globalThis.wsCall('get_group_member_info', { group_id: Number(chatId), user_id: Number(likeTargetQQ) }, 3000, ws);
                    if (memData && memData.data) targetName = memData.data.card || memData.data.nickname;
                } catch (e) {}
            }
            return `✨ 已成功为 @${targetName || likeTargetQQ} 点赞 ${times} 次！`;
        }
        return `✨ 点赞成功！[目标: 你] [关系: ${isFriend ? '好友' : '非好友'}] 本次共为你点赞 ${times} 次~\n(每日 0:00 刷新)`;
    }

    // ==========================================
    // 设置/取消管理
    // ==========================================
    if (cmd.startsWith('设置管理') || cmd.startsWith('取消管理')) {
      const isSet = cmd.startsWith('设置管理');
      if (!isMaster) return '❌ 权限不足：仅大主人可用。';
      if (!targetQQ) return `⚠️ 用法：${isSet ? '设置' : '取消'}管理@成员`;
      
      const loginData = await globalThis.wsCall('get_login_info', {}, 3000, ws);
      const botQQ = loginData?.data?.user_id;
      const botInfoData = await globalThis.wsCall('get_group_member_info', { group_id: Number(chatId), user_id: Number(botQQ) }, 3000, ws);
      if (botInfoData?.data?.role !== 'owner') return `❌ Bot权限不足：需要是群主才能设置/取消管理员。`;

      try {
        const res = await globalThis.wsCall('set_group_admin', { group_id: Number(chatId), user_id: Number(targetQQ), enable: isSet }, 5000, ws);
        return (res.status === 'ok' || res.retcode === 0) ? `✅ 已成功${isSet ? '设置' : '取消'}管理员。` : `❌ 失败。`;
      } catch (err) { return `❌ 请求失败：${err.message}`; }
    }

    // ==========================================
    // 群公告相关
    // ==========================================
    if (cmd.startsWith('群公告')) {
        if (!hasPermission) return '❌ 权限不足。';
        if (!(await checkBotRole(chatId, ws))) return '❌ 操作失败：Bot 不是管理员或群主，无法发布公告。';

        const noticeText = cmd.replace(/^群公告\s*/, '').trim();
        let imageUrl = ''; 
        const imgMatch = textStr.match(/\[CQ:image.*?url=(https?:\/\/[^\]]+)/);
        if (imgMatch) imageUrl = imgMatch[1];
        if (!noticeText && !imageUrl) return '⚠️ 用法：群公告 公告内容';
        try {
            const result = await globalThis.wsCall('_send_group_notice', { group_id: Number(chatId), content: noticeText || ' ', ...(imageUrl ? { image: imageUrl } : {}) }, 10000, ws);
            return (result.status === 'ok' || result.retcode === 0) ? '✅ 群公告发布成功！' : `❌ 失败：${result.msg || result.message}`;
        } catch (e) { return `❌ 失败：${e.message}`; }
    }

    if (cmd === '查公告' || cmd.startsWith('删公告')) {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        if (!hasPermission) return '❌ 权限不足：仅限管理员及以上身份使用。';
        if (!(await checkBotRole(chatId, ws))) return '❌ 操作失败：Bot 不是管理员或群主，无法操作公告。';

        if (cmd === '查公告') {
            try {
                const result = await globalThis.wsCall('_get_group_notice', { group_id: Number(chatId) }, 10000, ws);
                const notices = result.data || [];
                if (notices.length === 0) return '📭 当前群没有发布过任何公告。';
                
                if (notices.length > 3) {
                    let msgList = [];
                    for (let i = 0; i < notices.length; i++) {
                        const item = notices[i];
                        const date = new Date(item.publish_time * 1000).toLocaleString('zh-CN');
                        const contentText = item.message?.text ? item.message.text.replace(/\[CQ:image[^\]]*\]/g, '[图片]') : '未知内容';
                        msgList.push(`[ID: ${item.notice_id}]\n📅 ${date}\n📝 ${contentText}`);
                    }
                    msgList.unshift(`📢 本群共有 ${notices.length} 条公告（最新在前）：`);
                    if (await sendForwardMsg(chatId, isGroup, '群公告记录', msgList, ws)) return true;
                }
    
                let reply = `📢 本群共有 ${notices.length} 条公告（最新在前）：\n`;
                for (let i = 0; i < Math.min(notices.length, 5); i++) {
                    const item = notices[i];
                    const date = new Date(item.publish_time * 1000).toLocaleString('zh-CN');
                    const contentText = item.message?.text ? item.message.text.replace(/\[CQ:image[^\]]*\]/g, '[图片]') : '未知内容';
                    reply += `\n[ID: ${item.notice_id}]\n📅 ${date}\n📝 ${contentText.substring(0, 50)}${contentText.length > 50 ? '...' : ''}\n`;
                }
                if (notices.length > 5) reply += `\n... 仅显示最新 5 条\n`;
                return reply.trim() + `\n\n💡 发送：删公告 [ID] 可删除。`;
            } catch (e) { return `❌ 查公告失败: ${e.message}`; }
        }

        if (cmd.startsWith('删公告')) {
            const noticeId = cmd.split(/\s+/)[1];
            if (!noticeId) return '⚠️ 用法：删公告 [公告ID]\n请先发送“查公告”获取ID，防止误删。';
            try {
                const result = await globalThis.wsCall('_del_group_notice', { group_id: Number(chatId), notice_id: noticeId }, 5000, ws);
                return (result.status === 'ok' || result.retcode === 0) ? `✅ 已成功删除公告 [ID: ${noticeId}]。` : `❌ 删除失败：${result.msg || result.message || '可能是ID错误或公告已不存在'}`;
            } catch (e) { return `❌ 删除公告失败: ${e.message}`; }
        }
    }

    // ==========================================
    // 改头衔 (给别人改)
    // ==========================================
    if (cmd.startsWith('改头衔')) {
        let targetToChange = targetQQ;
        let isSelfChange = false;
        if (!targetToChange) { targetToChange = String(senderQQ); isSelfChange = true; }
    
        let newTitle = cmd.replace(/^改头衔\s*/, '').trim().replace(/@\{at:\d+\}/g, '').replace(/@\S+\s*/g, '').trim();
        if (!newTitle) return '❌ 请输入要设置的头衔内容，例如：改头衔 @某人 大佬';
        if (newTitle.length > 18) return '❌ 头衔过长：最多 18 个字符';
        
        let isGroupOwner = false;
        let isGroupAdmin = false;
        try {
            const res = await globalThis.wsCall('get_group_member_info', { group_id: Number(chatId), user_id: Number(senderQQ) }, 3000, ws);
            const rawRole = res?.data?.role;
            if (rawRole === 'owner') isGroupOwner = true;
            if (rawRole === 'admin') isGroupAdmin = true;
        } catch (e) {}

        let checkRole = (typeof getRole === 'function') ? getRole(senderQQ) : 'member';
        if (!isSelfChange && !isGroupOwner && !isGroupAdmin && !['master', 'owner', 'admin'].includes(checkRole)) {
            return `❌ 权限不足！系统识别你的身份为: ${checkRole}，QQ: ${senderQQ}`;
        }
    
        if (!isSelfChange) {
            const loginData = await globalThis.wsCall('get_login_info', {}, 3000, ws);
            const botQQ = loginData?.data?.user_id;
            const botInfoData = await globalThis.wsCall('get_group_member_info', { group_id: Number(chatId), user_id: Number(botQQ) }, 3000, ws);
            if (botInfoData?.data?.role !== 'owner') return '❌ Bot权限不足：机器人需要是群主才能修改他人头衔。';
        }

        try {
            const res = await globalThis.wsCall('set_group_special_title', { group_id: Number(chatId), user_id: Number(targetToChange), special_title: newTitle, duration: -1 }, 5000, ws);
            if (res?.status === 'ok' || res?.retcode === 0) {
                if (!targetName && !isSelfChange) {
                    try {
                        const memData = await globalThis.wsCall('get_group_member_info', { group_id: Number(chatId), user_id: Number(targetToChange) }, 3000, ws);
                        targetName = memData?.data?.card || memData?.data?.nickname;
                    } catch (e) {}
                }
                return `✅ 已将 ${isSelfChange ? '你' : (targetName || `@${targetToChange}`)} 的头衔修改为「${newTitle}」`;
            }
            return `❌ 修改失败：${res?.msg || res?.message || '未知错误'}`;
        } catch (err) { return `❌ 请求失败：${err.message}`; }
    }

    // ==========================================
    // 申请头衔 (给自己改)
    // ==========================================
    if (cmd.startsWith('申请头衔') || cmd.startsWith('头衔')) {
        const titleContent = cmd.replace(/^(申请头衔|头衔)\s*/, '').trim();
        if (!titleContent) return '⚠️ 用法：申请头衔 头衔内容';
    
        try {
            const loginData = await globalThis.wsCall('get_login_info', {}, 3000, ws);
            const botQQ = loginData?.data?.user_id;
            if (!botQQ) return '❌ 无法获取 Bot 账号信息';

            const botInfoData = await globalThis.wsCall('get_group_member_info', { group_id: Number(chatId), user_id: Number(botQQ) }, 3000, ws);
            if (botInfoData?.data?.role !== 'owner') {
                return '❌ 操作失败：Bot 当前不是群主，无法设置头衔。';
           }

           const res = await globalThis.wsCall('set_group_special_title', { 
               group_id: Number(chatId), 
                user_id: Number(senderQQ), 
                special_title: titleContent, 
                duration: -1 
           }, 5000, ws);
        
           if (res && (res.status === 'ok' || res.retcode === 0)) {
               return `✅ 已成功将你的头衔设置为：【${titleContent}】`;
           } else {
               const errMsg = res?.msg || res?.message || res?.wording || JSON.stringify(res) || '未知错误（接口返回为空）';
               return `❌ 设置头衔失败：${errMsg}`;
           }
        } catch (err) {
            return `❌ 请求异常：${err.message}`;
        }
    }

    return '';
  }
};