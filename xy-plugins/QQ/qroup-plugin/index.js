import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getRole } from '../../../xy-config/config/permissions.js';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_PATH = path.resolve(__dirname, '../../plugins/指令/menu.json');
const API = 'http://127.0.0.1:3000';

// 记录今天已点赞过的用户
const likedToday = new Set();
let lastRecordDate = new Date().getDate();
let botInfoData;

// 读取 bot.yaml 配置
let botConfig = {};
try {
    const yamlPath = path.join(__dirname, '../../../xy-config/config/bot.yaml');
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
  { cmd: '踢@成员', desc: '将指定成员踢出群聊' },
  { cmd: '禁言@成员QQ号 秒', desc: '禁言指定成员，默认600秒' },
  { cmd: '解禁@QQ号', desc: '解除指定成员的禁言' },
  { cmd: '头衔 内容 / 申请头衔 内容', desc: '给自己设置专属头衔（需机器人是群主）' },
  { cmd: '设置管理@成员', desc: '将指定成员设为管理员（需大主人权限）' },
  { cmd: '取消管理@成员', desc: '将指定成员降为普通成员（需大主人权限）' },
  { cmd: '点赞 / 赞我', desc: '让机器人给你点赞（好友10次，非好友50次）' },
  { cmd: '赞他@成员 / @成员 赞他', desc: '让机器人给指定成员点赞' },
  { cmd: '改头衔', desc: '让群主机器人改其他人的头衔（需要配置里的主人权限或者群管理权限）'},
  { cmd: '群公告', desc: '让机器人发群公告（需要机器人是群管理或者群主）'},
  { cmd: '群待办', desc: '让机器人置顶引用的消息'},
  { cmd: '取消待办', desc: '让机器人取消所有待办'},
  { cmd: '批量移出', desc: '批量移出群成员' },
  { cmd: '查等级 [等级]', desc: '查看群成员等级统计或指定等级人数' },
  { cmd: '查潜水 [天数]', desc: '查看超过指定天数未发言的成员（默认30天）' },
  { cmd: '清理潜水 [天数] -y', desc: '清理超过指定天数未发言的成员（必须带-y确认）' }
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

export default {
  name: '群管',
  description: '匹配规则：踢/禁言/解禁/头衔/设置管理/取消管理/点赞/查等级/查潜水/清理潜水',
  match: (text) => {
    if (!text || typeof text !== 'string') return false;
    
    const cmd = text.trim();
    
    return cmd.startsWith('踢') || cmd.startsWith('禁言') || cmd.startsWith('解禁')
        || cmd.startsWith('头衔') || cmd.startsWith('设置管理')
        || cmd.startsWith('取消管理') || cmd.startsWith('点赞')
        || cmd.startsWith('赞我') || cmd.startsWith('申请头衔')
        || cmd.includes('赞他') || cmd.includes('赞她') 
        || cmd.startsWith('改头衔') || cmd.startsWith('群公告')
        || cmd.startsWith('批量移出')
        || cmd.startsWith('群待办') || cmd.startsWith('取消待办')
        || cmd.startsWith('查等级') || cmd.startsWith('查潜水') || cmd.startsWith('清理潜水');
  },

  handle: async function({ text, pureText, chatId, isGroup, senderName, senderQQ, role }) {
    if (!text) return false;

    const cmd = (pureText || "").trim();
    if (!cmd) return false;

    let textStr = parseText(text).trim();

    // ==========================================
    // 提取目标QQ号
    // ==========================================
    let targetQQ = null;

    if (Array.isArray(text)) {
        const atItem = text.find(item => item?.type === 'at');
        if (atItem && atItem.data && (atItem.data.qq || atItem.data.target)) {
            targetQQ = String(atItem.data.qq || atItem.data.target);
        }
    } else if (typeof text === 'string') {
        const atMatch = text.match(/@\{at:(\d+)}/);
        if (atMatch) {
            targetQQ = atMatch[1];
        }
    }

    if (!targetQQ) {
        const match = textStr.match(/@\[([^\s]+)\]/);
        if (match) {
            const keyword = match[1];
            try {
                const memberRes = await fetch(`${API}/get_group_member_list?group_id=${chatId}`);
                const memberData = await memberRes.json();
                const members = memberData?.data || [];

                const found = members.find(m => {
                    const uid = String(m.user_id);
                    if (keyword.startsWith(uid)) return true;
                    if ((m.nickname && m.nickname.includes(keyword)) ||
                        (m.card && m.card.includes(keyword))) return true;
                    return false;
                });

                if (found) {
                    targetQQ = String(found.user_id);
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
    } catch (e) {}

    const configAdmin = ['master', 'owner', 'admin'];
    let hasPermission = isGroupAdmin || configAdmin.includes(role);

    if (!hasPermission && typeof getRole === 'function') {
      const userRole = getRole(senderQQ);
      if (configAdmin.includes(userRole)) hasPermission = true;
    }

    const isMaster = (role === 'master' || getRole(senderQQ) === 'master');

    // ==========================================
    // 🌟 查等级（支持带参数）
    // ==========================================
    if (cmd.startsWith('查等级')) {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        if (!hasPermission) return '❌ 权限不足：仅限管理员及以上身份使用。';

        const args = cmd.split(/\s+/);
        const targetLevel = args[1];

        try {
            const res = await fetch(`${API}/get_group_member_list?group_id=${chatId}`);
            const data = await res.json();
            const members = data?.data || [];
            if (members.length === 0) return '❌ 无法获取群成员列表';

            if (targetLevel) {
                const filtered = members.filter(m => String(m.level) === String(targetLevel));
                return `📊 本群等级为 Lv.${targetLevel} 的成员共有 ${filtered.length} 人。`;
            }

            const levelCount = {};
            for (const m of members) {
                const lvl = m.level || '0';
                levelCount[lvl] = (levelCount[lvl] || 0) + 1;
            }
            let levelText = `📊 本群成员等级统计（共 ${members.length} 人）：\n`;
            const sortedLvls = Object.keys(levelCount).sort((a, b) => parseInt(b) - parseInt(a));
            for (const lvl of sortedLvls) {
                levelText += `Lv.${lvl} : ${levelCount[lvl]} 人\n`;
            }
            return levelText.trim() + `\n💡 提示：发送“查等级 1”可查询指定等级人数。`;
        } catch (e) {
            return `❌ 查询等级失败: ${e.message}`;
        }
    }

    // ==========================================
    // 🌟 查潜水 / 清理潜水
    // ==========================================
    if (cmd.startsWith('查潜水') || cmd.startsWith('清理潜水')) {
        if (!isGroup) return '❌ 该指令仅限群聊使用';
        
        const isClean = cmd.startsWith('清理潜水');
        const args = cmd.split(/\s+/);
        const days = parseInt(args[1]) || 30;
        
        if (isClean && !cmd.includes('-y')) {
            return `⚠️ 危险操作！如需清理，请发送：清理潜水 ${days} -y\n或先发送：查潜水 ${days} 查看名单。`;
        }

        try {
            const memberRes = await fetch(`${API}/get_group_member_list?group_id=${chatId}`);
            const memberData = await memberRes.json();
            const members = memberData?.data || [];
            if (members.length === 0) return '❌ 无法获取群成员列表';

            const botRes = await fetch(`${API}/get_login_info`);
            const botData = await botRes.json();
            const botQQ = botData?.data?.user_id;

            const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
            const silentMembers = [];

            for (const m of members) {
                if (m.role === 'owner' || m.role === 'admin' || m.user_id == botQQ) continue;
                
                let lastTime = 0;
                if (m.last_sent_time && m.last_sent_time > 0) {
                    lastTime = m.last_sent_time * 1000;
                } else if (m.join_time && m.join_time > 0) {
                    lastTime = m.join_time * 1000;
                }

                if (lastTime > 0 && lastTime < threshold) {
                    silentMembers.push(m);
                }
            }

            if (silentMembers.length === 0) {
                return `✅ 没有超过 ${days} 天未发言的普通成员。`;
            }

            silentMembers.sort((a, b) => {
                const timeA = (a.last_sent_time || a.join_time || 0);
                const timeB = (b.last_sent_time || b.join_time || 0);
                return timeA - timeB;
            });

            const displayLimit = 50;
            const listText = silentMembers.slice(0, displayLimit).map(m => `${m.card || m.nickname} (${m.user_id})`).join('\n');
            let resultMsg = `📊 超过 ${days} 天未发言的成员共 ${silentMembers.length} 人：\n${listText}\n`;
            if (silentMembers.length > displayLimit) {
                resultMsg += `...（名单过长，仅显示前 ${displayLimit} 人）\n`;
            }

            if (!isClean) {
                return resultMsg + `\n⚠️ 若要清理他们，请发送：清理潜水 ${days} -y`;
            }

            if (!hasPermission) return '❌ 权限不足：此命令仅限群主、管理员或配置文件中的主人使用。';
            
            resultMsg += `\n🚀 开始批量清理...\n`;
            let successCount = 0;
            let failCount = 0;

            for (const m of silentMembers) {
                await new Promise(r => setTimeout(r, Math.random() * 400 + 300));
                try {
                    const kickRes = await fetch(`${API}/set_group_kick`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            group_id: Number(chatId),
                            user_id: Number(m.user_id),
                            reject_add_request: true
                        })
                    });
                    const kickData = await kickRes.json();
                    if (kickData.status === 'ok' || kickData.retcode === 0) {
                        successCount++;
                    } else {
                        failCount++;
                    }
                } catch (_) {
                    failCount++;
                }
            }

            return resultMsg + `✅ 清理完成！成功移出 ${successCount} 人，失败 ${failCount} 人。`;

        } catch (e) {
            return `❌ 查询或清理失败: ${e.message}`;
        }
    }

    // ==========================================
    // 🌟 点赞功能
    // ==========================================
    if (cmd === '点赞' || cmd === '赞' || cmd === '赞我' || cmd.startsWith('赞他') || cmd.startsWith('赞她')) {
        let likeTargetQQ = senderQQ; 
        let isLikeOther = false;

        if (cmd.startsWith('赞他') || cmd.startsWith('赞她')) {
            isLikeOther = true;
            if (!targetQQ) return '⚠️ 用法：赞他 @成员（请@你想要点赞的人）';
            if (targetQQ === senderQQ) return '✨ 请不要用 赞他 来赞自己，直接发 赞我 即可~';
            likeTargetQQ = targetQQ;
        }

        checkAndResetDaily();
        if (!isLikeOther && likedToday.has(senderQQ)) return '今天已经给自己点过赞啦，明天再来吧~';
        if (botConfig.bot && botConfig.bot.likeEnabled === false) return '❌ 点赞功能已关闭';

        let isFriend = false;
        try {
            const friendRes = await fetch(`${API}/get_friend_list`);
            const friendData = await friendRes.json();
            const friends = friendData.data || friendData.data?.data || [];
            if (friends.some(f => f.user_id == likeTargetQQ)) isFriend = true;
        } catch (e) {}

        const times = isFriend ? 10 : 50;
        const identity = isFriend ? '好友' : '非好友';
        const loops = Math.ceil(times / 10);
        for (let i = 0; i < loops; i++) {
            try { await fetch(`${API}/send_like?user_id=${likeTargetQQ}&times=10`); } catch (e) {}
        }

        if (!isLikeOther) likedToday.add(senderQQ);
        const targetName = isLikeOther ? `@${likeTargetQQ}` : '你';
        return `✨ 点赞成功！[目标: ${targetName}] [关系: ${identity}] 本次共为你点赞 ${times} 次~`;
    }

    // ==========================================
    // 设置管理
    // ==========================================
    if (cmd.startsWith('设置管理')) {
      if (!isMaster) return '❌ 权限不足：此命令仅限配置文件中的大主人（master）使用。';
      if (!targetQQ) return '⚠️ 用法：设置管理@成员';

      try {
        const botRes = await fetch(`${API}/get_login_info`);
        const botData = await botRes.json();
        const botQQ = botData?.data?.user_id;

        if (botQQ) {
          const botInfoRes = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${botQQ}`);
          botInfoData = await botInfoRes.json();
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

    // ==========================================
    // 取消管理
    // ==========================================
    if (cmd.startsWith('取消管理')) {
      if (!isMaster) return '❌ 权限不足：此命令仅限配置文件中的大主人（master）使用。';
      if (!targetQQ) return '⚠️ 用法：取消管理@成员';

      try {
        const botRes = await fetch(`${API}/get_login_info`);
        const botData = await botRes.json();
        const botQQ = botData?.data?.user_id;

        if (botQQ) {
          const botInfoRes = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${botQQ}`);
          botInfoData = await botInfoRes.json();
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

    // ==========================================
    // 发送群公告
    // ==========================================
    if (cmd.startsWith('群公告')) {
        if (!hasPermission) return '❌ 权限不足：此命令仅限管理员使用';

        const botRes = await fetch(`${API}/get_login_info`);
        const botData = await botRes.json();
        const botQQ = botData?.data?.user_id;

        if (botQQ) {
          const botInfoRes = await fetch(`${API}/get_group_member_info?group_id=${chatId}&user_id=${botQQ}`);
          botInfoData = await botInfoRes.json();
          if (botInfoData?.data?.role !== 'owner' && botInfoData?.data?.role !== 'admin') {
            return '❌ Bot权限不足：需要先给Bot设置群管理员或者群主。';
          }
        }

        const noticeText = text.replace(/^群公告\s*/, '').trim();
        if (!noticeText) return '⚠️ 用法：群公告 公告内容（可附带一张图片）';

        let imageUrl = '';
        const imgMatch = text.match(/\[CQ:image.*?url=(https?:\/\/[^\]]+)/);
        if (imgMatch) {
            imageUrl = imgMatch[1];
        }

        const bodyData = {
            group_id: Number(chatId),
            content: noticeText
        };
        if (imageUrl) {
            bodyData.image = imageUrl;
        }

        try {
            const res = await fetch(`${API}/_send_group_notice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData)
            });
            const result = await res.json();
            if (result.status === 'ok') {
                return '✅ 群公告发布成功！';
            } else {
                return `❌ 发布公告失败：${result.msg || result.message}`;
            }
        } catch (e) {
            return `❌ 发布公告失败：${e.message}`;
        }
    }

    // ==========================================
    // 踢人
    // ==========================================
    if (cmd.startsWith('踢')) {
      if (!targetQQ) return '⚠️ 用法：踢@成员';
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

    // ==========================================
    // 批量移出
    // ==========================================
    if (cmd.startsWith('批量移出')) {
          const isReject = /(-r|--拒|--拒绝)/i.test(textStr);
          const cleanText = textStr.replace(/(-r|--拒|--拒绝)/ig, '').trim();
          const targets = [];

          if (Array.isArray(text)) {
              for (const seg of text) {
                  if (seg?.type === 'at' && seg.data) {
                      const qq = seg.data.qq || seg.data.target;
                      if (qq) targets.push(String(qq).replace(/[^0-9]/g, ''));
                  }
              }
          } else if (typeof text === 'string') {
              for (const m of cleanText.matchAll(/\[CQ:at,qq=(\d+)\]/g)) {
                  targets.push(m[1]);
              }
              for (const m of cleanText.matchAll(/(?<![0-9])([1-9][0-9]{4,11})(?![0-9])/g)) {
                  targets.push(m[1]);
              }
          }

          const uniqueTargets = [...new Set(targets.filter(q => q.length >= 5))];

          if (uniqueTargets.length === 0) {
              return '未找到要移出的人，请 @ 对方或输入 QQ 号';
          }

          let successCount = 0;

          try {
              const r = await fetch(`${API}/set_group_kick_members`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      group_id: String(chatId),
                      user_id: uniqueTargets
                  })
              });
              const d = await r.json();
              if (d.status === 'ok' || d.retcode === 0) {
                  successCount = uniqueTargets.length;
              }
          } catch (_) {}

          if (successCount === 0) {
              try {
                  const r = await fetch(`${API}/batch_delete_group_member`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          group_id: Number(chatId),
                          user_ids: uniqueTargets
                      })
                  });
                  const d = await r.json();
                  if (d.status === 'ok' || d.retcode === 0) {
                      successCount = uniqueTargets.length;
                  }
              } catch (_) {}
          }

          if (successCount === 0) {
              for (const uid of uniqueTargets) {
                  await new Promise(resolve => setTimeout(resolve, Math.random() * 600 + 400));
                  try {
                      const r = await fetch(`${API}/set_group_kick`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              group_id: Number(chatId),
                              user_id: Number(uid),
                              reject_add_request: isReject
                          })
                      });
                      const d = await r.json();
                      if (d.status === 'ok' || d.retcode === 0) {
                          successCount++;
                      }
                  } catch (_) {}
              }
          }

          const msg = `批量移出完成：成功 ${successCount}/${uniqueTargets.length} 人 | 拒绝再次加群：${isReject ? '是' : '否'}`;
          return msg;
      }

    // ==========================================
    // 禁言
    // ==========================================
    if (cmd.startsWith('禁言')) {
        if (!targetQQ) return '⚠️ 用法：禁言@成员 [秒数/分钟/小时/天数]，例：禁言@成员 5m 或 1天';
        if (!hasPermission) return '❌ 权限不足：此命令仅限群主、管理员或配置文件中的主人使用。';

        let duration = 600; // 默认10分钟
        let cmdClean = cmd;
        if (targetQQ) {
            cmdClean = cmd.replace(targetQQ, "");
        }

        const durationMatch = cmdClean.match(/(\d+)\s*(s|秒|m|分钟|min|h|小时|d|天|日)?/i);
        if (durationMatch) {
            const value = parseInt(durationMatch[1]);
            const unit = (durationMatch[2] || 'm').toLowerCase();

            switch (unit) {
                case 's':
                case '秒':
                    duration = value;
                    break;
                case 'm':
                case '分钟':
                case 'min':
                    duration = value * 60;
                    break;
                case 'h':
                case '小时':
                    duration = value * 60 * 60;
                    break;
                case 'd':
                case '天':
                case '日':
                    duration = value * 60 * 60 * 24;
                    break;
                default:
                    duration = value * 60; 
            }
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
        } catch (e) {
            return `❌ 禁言失败：${e.message}`;
        }
    }

    // ==========================================
    // 解禁
    // ==========================================
    if (cmd.startsWith('解禁')) {
      if (!targetQQ) return '⚠️ 用法：解禁@成员';
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

    // ==========================================
    // 改头衔
    // ==========================================
    if (cmd.startsWith('改头衔')) {
        if (!targetQQ) {
            return '❌ 格式错误：改头衔 @成员 新头衔（改自己直接：改头衔 新头衔）';
        }

        let newTitle = '';
        if (Array.isArray(text)) {
            newTitle = text
                .filter(item => item?.type === 'text')
                .map(item => item?.data?.text || '')
                .join('')
                .trim()
                .replace(/^改头衔\s*/, '') 
                .trim();
        } else {
            newTitle = textStr.replace(/^改头衔/, '').trim();
            const bracketIndex = newTitle.indexOf(']');
            if (bracketIndex !== -1) {
                newTitle = newTitle.substring(bracketIndex + 1).trim();
            } else {
                newTitle = newTitle.replace(/^@\S+\s*/, '').trim();
            }
        }

        if (!newTitle) {
            return '❌ 请输入要设置的头衔';
        }
        if (newTitle.length > 18) {
            return '❌ 头衔过长：最多 18 个字符';
        }

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
            const highAdmin = ['master', 'owner'].includes(role);
            if (!isGroupOwner && !isGroupAdmin && !highAdmin) {
                return '❌ 权限不足：改别人头衔需要群主/群管或主人权限';
            }
        }

        try {
            const res = await fetch(`${API}/set_group_special_title`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    group_id: Number(chatId),
                    user_id: Number(targetQQ),
                    special_title: newTitle,
                    duration: -1 
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

    // ==========================================
    // 申请头衔
    // ==========================================
    if (cmd.startsWith('头衔') || cmd.startsWith('申请头衔')) {
      const titleContent = cmd.replace(/^(申请头衔|头衔)\s*/, '').trim();
      if (!titleContent) return '⚠️ 用法：头衔 头衔内容';

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
        botInfoData = await botInfoRes.json();
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

    return '⚠️ 用法：\n踢@成员\n禁言@成员 时长\n解禁@成员\n头衔 内容\n设置管理@成员（仅大主人）\n取消管理@成员（仅大主人）\n点赞\n查等级\n查潜水 [天数]\n清理潜水 [天数] -y';
  }
};