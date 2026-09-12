import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getRole } from '../../xy-config/config/permissions.js';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_PATH = path.resolve(__dirname, '../指令/menu.json');
const API = 'http://127.0.0.1:3002';

// 记录今天已点赞过的用户
const likedToday = new Set();
let lastRecordDate = new Date().getDate();

// 读取 bot.yaml 配置
let botConfig = {};
try {
    const yamlPath = path.join(__dirname, '../../xy-config/config/bot.yaml');
    const yamlContent = fs.readFileSync(yamlPath, 'utf8');
    botConfig = parseYaml(yamlContent) || {};
} catch (e) {
    console.log('[配置警告] 读取 bot.yaml 失败:', e.message);
}

// 每天自动清空点赞记录
function checkAndResetDaily() {
    const today = new Date().getDate();
    if (today !== lastRecordDate) {
        likedToday.clear();
        lastRecordDate = today;
  }
}

const myCommands = [
  { cmd: '#踢@成员', desc: '将指定成员踢出群聊' },
  { cmd: '#禁言@成员QQ号 秒', desc: '禁言指定成员，默认600秒' },
  { cmd: '#解禁@QQ号', desc: '解除指定成员的禁言' },
  { cmd: '#头衔 内容/#申请头衔 内容', desc: '给自己设置专属头衔（需机器人是群主）' },
  { cmd: '#设置管理@成员', desc: '将指定成员设为管理员（需大主人权限）' },
  { cmd: '#取消管理@成员', desc: '将指定成员降为普通成员（需大主人权限）' },
  { cmd: '#点赞/#赞我', desc: '让机器人给你点赞（好友10次，非好友50次）' },
  { cmd: '#改头衔', desc: '让群主机器人改其他人的头衔（需要配置里的主人权限或者群管理权限）'},
];

function injectHelp() {
  if (!fs.existsSync(MENU_PATH)) {
    console.log('[群管] 找不到 menu.json，跳过帮助注册');
    return;
  }
  try {
    let menu = JSON.parse(fs.readFileSync(MENU_PATH, 'utf-8'));
    const existingCmds = Object.values(menu.commands || {}).map(v => v.cmd);
    const alreadyInjected = myCommands.every(c => existingCmds.includes(c.cmd));

    if (alreadyInjected) {
      console.log('[群管] 指令已存在，跳过引入');
      return;
    }

    let maxId = 0;
    for (const key of Object.keys(menu.commands || {})) {
      const num = parseInt(key);
      if (!isNaN(num) && maxId < num) maxId = num;
    }

    const myIds = [];
    for (const item of myCommands) {
      maxId++;
      if (!menu.commands) menu.commands = {};
      menu.commands[maxId] = { cmd: item.cmd, desc: item.desc };
      myIds.push(maxId);
    }

    if (!menu.categories) menu.categories = [];
    menu.categories.push({
      name: '群管',
      description: '群管理（管理员及以上可用）',
      color: '#459c5f',
      items: myIds
    });

    menu.version = (menu.version || 0) + 1;
    fs.writeFileSync(MENU_PATH, JSON.stringify(menu, null, 4), 'utf-8');
    console.log('[群管] 帮助信息已注册到 menu.json，版本已升至:', menu.version);
  } catch (e) {
    console.error('[群管] 读取 menu.json 失败:', e.message);
  }
}

injectHelp();

function parseText(text) {
  let textStr = '';
  if (Array.isArray(text)) {
    textStr = text.map(item => item?.data?.text ? item.data.text : '').join('');
  } else if (typeof text === 'object' && text != null && text.text !== undefined) {
    textStr = text.text;
  } else if (typeof text === 'string') {
    textStr = text;
  } else {
    textStr = String(text || '');
  }
  return textStr;
}

// 判断目标QQ是否为机器人好友
async function checkIsFriend(targetQQ) {
  try {
    const res = await fetch(`${API}/get_friends`);
    const data = await res.json();
    if (data.status === 'ok' && data.data) {
      const friends = data.data;
      return friends.some(f => f.user_id === Number(targetQQ));
    }
  } catch (e) {
    console.error('[群管] 获取好友列表失败:', e.message);
  }
  return false;
}

export default {
  name: '群管',
  description: '匹配规则：消息包含 #踢/#禁言/#解禁/#头衔/#设置管理/#取消管理/#点赞 触发',
  match: (text) => {
    if (!text) return false;
    let textStr = parseText(text);
    textStr = textStr.trim();
    if (!textStr) return false;

    const hasPrefix = textStr.startsWith('#');
    if (!hasPrefix) return false;

    const cmd = textStr.replace(/^#s#|#/g, '').trim();
    return cmd.startsWith('踢') || cmd.startsWith('禁言') || cmd.startsWith('解禁')
        || cmd.startsWith('头衔') || cmd.startsWith('设置管理')
        || cmd.startsWith('取消管理') || cmd.startsWith('点赞')
        || cmd.startsWith('赞我') || cmd.startsWith('申请头衔')
        || cmd.startsWith('改头衔');
  },

  handle: async function({ text, chatId, isGroup, senderName, senderQQ, role }) {
    console.log('[群管-调试] text 类型:', typeof text, '是否数组:', Array.isArray(text));
    console.log('[群管-调试] text 内容:', JSON.stringify(text, null, 2));

    if (!text) return false;

    let textStr = parseText(text);
    textStr = textStr.trim();
    if (!textStr) return false;

    const hasPrefix = textStr.startsWith('#');
    if (!hasPrefix) return false;

    const cmd = textStr.replace(/^#s#|#/g, '').trim();

     // 获取目标QQ号
    let targetQQ = null;

    // 1. 数组格式处理（标准消息段）
    if (Array.isArray(text)) {
        const atItem = text.find(item => item?.type === 'at');
        if (atItem && atItem.data && (atItem.data.qq || atItem.data.target)) {
            targetQQ = String(atItem.data.qq || atItem.data.target);
        }
    } 
    // 2. 字符串格式处理（兼容你终端里打印出来的 @[at:3758575163] 格式）
    else if (typeof text === 'string') {
        const atMatch = text.match(/@\[at:(\d+)\]/);
        if (atMatch) {
            targetQQ = atMatch[1];
        }
    }

    // 3. 如果上面没拿到 QQ，尝试从文本里匹配昵称/备注（兼容手动输入名字踢人）
    if (!targetQQ) {
        const match = textStr.match(/@([^\s]+)/);
        if (match) {
            const keyword = match[1];
            try {
                const memberRes = await fetch(`${API}/get_group_member_list?group_id=${chatId}`);
                const memberData = await memberRes.json();
                const members = memberData?.data || [];

                const found = members.find(m => {
                    const uid = String(m.user_id);
                    if (keyword.startsWith(uid)) return true;
                    if ((m.nickname && keyword.includes(m.nickname)) || 
                        (m.card && keyword.includes(m.card))) return true;
                    return false;
                });

                if (found) {
                    targetQQ = String(found.user_id);
                    if (keyword.startsWith(targetQQ) && keyword.length > targetQQ.length) {
                        const remaining = keyword.slice(targetQQ.length);
                        textStr = textStr.replace(keyword, targetQQ + ' ' + remaining);
                    }
                }
            } catch (e) {
                console.error('匹配群成员失败:', e);
            }
        }
    }

    // 检查群权限
    let isGroupAdmin = false;
    try {
      const res = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${senderQQ}`);
      const data = await res.json();
      const rawRole = data?.data?.role;
      if (rawRole === 'owner' || rawRole === 'admin') {
        isGroupAdmin = true;
      }
    } catch (e) {
      // 忽略
    }

    const configAdmin = ['master', 'owner', 'admin'];
    let hasPermission = isGroupAdmin || configAdmin.includes(role);

    if (!hasPermission && typeof getRole === 'function') {
      const userRole = getRole(senderQQ);
      if (configAdmin.includes(userRole)) hasPermission = true;
    }

    // 大主人权限检查（设置管理、取消管理）
    const isMaster = role === 'master';

    // 点赞功能（无需权限，所有人都可以用）
    if (cmd === '点赞' || cmd === '赞' || cmd === '赞我') {

        checkAndResetDaily();

        // 1. 检查今天是否已经赞过了
        if (likedToday.has(senderQQ)) {
            return '今天已经点过赞啦，明天再来吧~';
        }

        // 2. 检查配置开关
        if (botConfig.bot && botConfig.bot.likeEnabled === false) {
            return '❌ 点赞功能已关闭';
        }

        // 3. 调用接口获取好友列表，判断是否为好友
        let isFriend = false;
        try {
            const friendRes = await fetch(`${API}/get_friend_list`);
            const friendData = await friendRes.json();
            // 兼容不同框架的数据结构（data 可能是数组，也可能在 data.data 里）
            const friends = friendData.data || friendData.data?.data || [];
            if (friends.some(f => f.user_id == senderQQ)) {
                isFriend = true;
            }
        } catch (e) {
            console.log('获取好友列表失败:', e.message);
        }

        // 4. 根据身份决定点赞次数（好友10次，非好友50次）
        const times = isFriend ? 10 : 50;
        const identity = isFriend ? '好友' : '非好友';

        // 5. 执行点赞（接口单次最多赞10次，所以用循环）
        const loops = Math.ceil(times / 10);
        for (let i = 0; i < loops; i++) {
            try {
                await fetch(`${API}/send_like?user_id=${senderQQ}&times=10`);
            } catch (e) {
                console.log('点赞请求异常:', e.message);
            }
        }

        // 6. 记录今天已赞，防止重复点赞
        likedToday.add(senderQQ);

        return `✨ 点赞成功！[身份: ${identity}] 本次共为你点赞 ${times} 次~`;
    }

    // 设置管理（仅大主人）
    if (cmd.startsWith('设置管理')) {
      if (!isMaster) return '❌ 权限不足：此命令仅限配置文件中的大主人（master）使用。';
      if (!targetQQ) return '⚠️ 用法：#设置管理@成员';

      try {
        const botRes = await fetch(`${API}/get_login_info`);
        const botData = await botRes.json();
        const botQQ = botData?.data?.user_id;

        if (botQQ) {
          const botInfoRes = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${botQQ}`);
          const botInfoData = await botInfoRes.json();
          if (botInfoData?.data?.role !== 'owner') {
            return '❌ Bot权限不足：机器人需要是群主才能设置管理员。';
          }
        }

        const res = await fetch(`${API}/set_group_admin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_id: Number(chatId),
            user_id: Number(targetQQ),
            enable: true
          })
        });
        const result = await res.json();
        if (result.status === 'ok') {
          return `✅ 已成功将 ${targetQQ} 设置为管理员。`;
        } else {
          return `❌ 设置管理失败：${result.msg || result.message}`;
        }
      } catch (err) {
        return `❌ 请求失败：${err.message}`;
      }
    }

    // 取消管理（仅大主人）
    if (cmd.startsWith('取消管理')) {
      if (!isMaster) return '❌ 权限不足：此命令仅限配置文件中的大主人（master）使用。';
      if (!targetQQ) return '⚠️ 用法：#取消管理@成员';

      try {
        const botRes = await fetch(`${API}/get_login_info`);
        const botData = await botRes.json();
        const botQQ = botData?.data?.user_id;

        if (botQQ) {
          const botInfoRes = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${botQQ}`);
          const botInfoData = await botInfoRes.json();
          if (botInfoData?.data?.role !== 'owner') {
            return '❌ Bot权限不足：机器人需要是群主才能取消管理员。';
          }
        }

        const res = await fetch(`${API}/set_group_admin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_id: Number(chatId),
            user_id: Number(targetQQ),
            enable: false
          })
        });
        const result = await res.json();
        if (result.status === 'ok') {
          return `✅ 已成功取消 ${targetQQ} 的管理员身份。`;
        } else {
          return `❌ 取消管理失败：${result.msg || result.message}`;
        }
      } catch (err) {
        return `❌ 请求失败：${err.message}`;
      }
    }

    // 踢人
    if (cmd.startsWith('踢')) {
      if (!targetQQ) return '⚠️ 用法：#踢@成员';
      if (!hasPermission) return '❌ 权限不足：此命令仅限群主、管理员或配置文件中的主人使用。';

      try {
        const res = await fetch(`${API}/set_group_kick`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_id: Number(chatId),
            user_id: Number(targetQQ),
            reject_add_request: false
          })
        });
        const result = await res.json();
        if (result.status === 'ok') {
          return `✅ 已成功踢出 ${targetQQ}`;
        } else {
          return `❌ 踢人失败：${result.msg || result.message}`;
        }
      } catch (err) {
        return `❌ 请求失败：${err.message}`;
      }
    }

    // 禁言
    if (cmd.startsWith('禁言')) {
      if (!targetQQ) return '⚠️ 用法：#禁言@成员 [秒数]';
      if (!hasPermission) return '❌ 权限不足：此命令仅限群主、管理员或配置文件中的主人使用。';

      let duration = 600;
      let cmdClean = cmd;
      if (targetQQ) {
        cmdClean = cmd.replace(targetQQ, '');
      }
      const durationMatch = cmdClean.match(/(\d+)/);
      if (durationMatch) {
        duration = parseInt(durationMatch[1]) * 600;
      }

      try {
        const res = await fetch(`${API}/set_group_ban`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_id: Number(chatId),
            user_id: Number(targetQQ),
            duration: duration
          })
        });
        const result = await res.json();
        if (result.status === 'ok') {
          return `✅ 已禁言 @${targetQQ} ${duration}秒`;
        } else {
          return `❌ 禁言失败：${result.msg || result.message}`;
        }
      } catch (err) {
        return `❌ 请求失败：${err.message}`;
      }
    }

    // 解禁
    if (cmd.startsWith('解禁')) {
      if (!targetQQ) return '⚠️ 用法：#解禁@成员';
      if (!hasPermission) return '❌ 权限不足：此命令仅限群主、管理员或配置文件中的主人使用。';

      try {
        const res = await fetch(`${API}/set_group_ban`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_id: Number(chatId),
            user_id: Number(targetQQ),
            duration: 0
          })
        });
        const result = await res.json();
        if (result.status === 'ok') {
          return `✅ 已成功解除 @${targetQQ} 的禁言`;
        } else {
          return `❌ 解禁失败：${result.msg || result.message}`;
        }
      } catch (err) {
        return `❌ 请求失败：${err.message}`;
      }
    }

    // ====== #改头衔 指令 ======
    if (cmd.startsWith('改头衔')) {
        if (!targetQQ) {
            return '❌ 格式错误：#改头衔 @成员 新头衔（改自己直接：#改头衔 新头衔）';
        }

        // 提取头衔文本：从 text 数组取纯文本段（跳过 at 类型）
        let newTitle = '';
        if (Array.isArray(text)) {
            newTitle = text
                .filter(item => item?.type === 'text')
                .map(item => item?.data?.text || '')
                .join('')
                .trim()
                .replace(/^#改头衔\s*/, '')
                .trim();
        } else {
            newTitle = textStr.replace(/^#改头衔/, '').trim();
    
            // 找到 @ 标签的结束符号 ']'
            const bracketIndex = newTitle.indexOf(']');
            if (bracketIndex !== -1) {
                // 截取 ']' 之后的内容作为新头衔
                newTitle = newTitle.substring(bracketIndex + 1).trim();
            } else {
                // 兼容旧格式：如果没有 ']'，去掉开头的 '@xxx'
                newTitle = newTitle.replace(/^@\S+\s*/, '').trim();
            }
        }

        // 在这行前面加 log 👇
        console.log('newTitle当前值:', JSON.stringify(newTitle));
        console.log('text数组结构:', JSON.stringify(text));

        if (!newTitle) {
            return '❌ 请输入要设置的头衔';
        }
        if (newTitle.length > 18) {
            return '❌ 头衔过长：最多 18 个字符';
        }

        // ---------- 权限判断 ----------
        const isSelf = targetQQ === String(senderQQ);
        let isGroupOwner = false;
        let isGroupAdmin = false;

        try {
            const res = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${senderQQ}`);
            const data = await res.json();
            const rawRole = data?.data?.role;
            if (rawRole === 'owner') isGroupOwner = true;
            if (rawRole === 'owner' || rawRole === 'admin') isGroupAdmin = true;
        } catch (e) {}

        if (!isSelf) {
            // 改别人：需要QQ群主/群管，或配置master/owner
            const highAdmin = ['master', 'owner'].includes(role);
            if (!isGroupOwner && !isGroupAdmin && !highAdmin) {
                return '❌ 权限不足：改别人头衔需要群主/群管或主人权限';
            }
        }

        // ---------- 调用API改头衔 ----------
        try {
            const res = await fetch(`${API}/set_group_special_title`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    group_id: Number(chatId),
                    user_id: Number(targetQQ),
                    special_title: newTitle,
                    duration: -1  // -1 表示永久
                })
            });
           const rawText = await res.text();
           const startIdx = rawText.indexOf('{');
           const endIdx = rawText.indexOf('}', startIdx);
           const jsonStr = rawText.substring(startIdx, endIdx + 1);
           let result;
           try {
               result = JSON.parse(jsonStr);
           } catch (e) {
               if (res.ok) {
                   result = { status: 'ok', retcode: 0 };
               } else {
                   throw new Error(`HTTP ${res.status}: ${rawText}`);
               }
           }

            if (result.status === 'ok') {
                return `✅ 已将头衔修改为「${newTitle}」`;
            } else {
                return `❌ 修改失败：${result.msg || result.message}`;
            }
        } catch (err) {
            return `❌ 请求失败：${err.message}`;
        }
    }

    // 头衔
    if (cmd.startsWith('头衔') || cmd.startsWith('申请头衔')) {
      const titleContent = cmd.replace(/^(申请头衔|头衔)\s*/, '').trim();
      if (!titleContent) return '⚠️ 用法：#头衔 头衔内容';

      let botQQ = null;
      try {
        const loginRes = await fetch(`${API}/get_login_info`);
        const loginData = await loginRes.json();
        botQQ = loginData?.data?.user_id;
      } catch (e) {
        return '❌ 无法获取机器人信息，请检查API连接。';
      }

      if (!botQQ) return '❌ 获取机器人QQ号失败。';

      try {
        const botInfoRes = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${botQQ}`);
        const botInfoData = await botInfoRes.json();
        const botRole = botInfoData?.data?.role;
        if (botRole !== 'owner') {
          return '❌ 操作失败：机器人当前不是群主，无法设置头衔。';
        }
      } catch (e) {
        return '❌ 无法查询机器人权限状态：' + e.message;
      }

      try {
        const res = await fetch(`${API}/set_group_special_title`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_id: Number(chatId),
            user_id: Number(senderQQ),
            special_title: titleContent
          })
        });
        const result = await res.json();
        if (result.status === 'ok') {
          return `✅ 已成功将你的头衔设置为：【${titleContent}】`;
        } else {
          return `❌ 设置头衔失败：${result.msg || result.message}`;
        }
      } catch (err) {
        return `❌ 请求失败：${err.message}`;
      }
    }

    return '⚠️ 用法：\n#踢@成员\n#禁言@成员 时长\n#解禁@成员\n#头衔 内容\n#设置管理@成员（仅大主人）\n#取消管理@成员（仅大主人）\n#点赞';
  }
};
