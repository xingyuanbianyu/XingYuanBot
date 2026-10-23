import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const GLOBAL_CONFIG_PATH = path.join(process.cwd(), 'xy-config/config/config.yaml');

// 🌟 使用本地 better-sqlite3 建表
const DB_PATH = path.join(__dirname, 'anti_recall.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 创建专属推送表（主人QQ -> 专属群号）
db.exec(`
  CREATE TABLE IF NOT EXISTS exclusive_push (
    user_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL
  )
`);

const backupCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;

export default {
  name: '防撤回',
  events: ['group.recall', 'friend.recall'],

  loadConfig() {
    try { return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) { return {}; }
  },

  // 🌟 动态获取全局配置里的前缀列表
  getPrefixes() {
    try {
      if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return ['#', '/'];
      const authConfig = yaml.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) || {};
      if (authConfig.command_prefix && Array.isArray(authConfig.command_prefix.prefixes)) {
          return authConfig.command_prefix.prefixes;
      }
      return ['#', '/'];
    } catch (e) { return ['#', '/']; }
  },

  getOwners() {
    try {
      if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return [];
      const authConfig = yaml.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) || {};
      const ownersObj = authConfig.permissions?.owners || {};
      const permStatus = authConfig.permissions?.owner_permission || {};
      const validOwners = [];
      for (const [qq, isMaster] of Object.entries(ownersObj)) {
          const qqStr = String(qq).trim();
          if (!qqStr) continue;
          if (isMaster === true || isMaster === 'true') validOwners.push(qqStr);
          else if (permStatus[qqStr] !== 0) validOwners.push(qqStr);
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

    // 🌟 核心修复：动态剥离所有配置中的前缀
    let cmd = (msg.pureText || "").trim();
    const prefixes = this.getPrefixes();
    for (const p of prefixes) {
        if (cmd.startsWith(p)) {
            cmd = cmd.slice(p.length).trim();
            break;
        }
    }
    // 兜底：如果还有硬编码没囊括进去的，再统一清理一下
    cmd = cmd.replace(/^[#\/$!]+\s*/, '');

    // 判断是不是拦截相关的指令
    const isInterceptCmd = cmd.startsWith('指定拦截') || cmd.startsWith('取消拦截') || cmd.startsWith('查看拦截');

    if (isInterceptCmd) {
        const owners = this.getOwners();
        const isSenderOwner = owners.includes(senderQQ);

        if (!isSenderOwner) {
            return '❌ 权限不足：仅主人可配置专属拦截。';
        }

        // ==========================================
        // 1. 指定拦截
        // ==========================================
        if (cmd.startsWith('指定拦截')) {
            const content = cmd.replace('指定拦截', '').trim();
            // 匹配格式：QQ号 或 QQ号 群号
            const match = content.match(/^(\d{5,12})(?:\s+(\d{5,12}))?$/);
            
            if (!match) {
                return '⚠️ 用法：\n指定拦截 QQ号 群号 (指定某个主人只听某个群)\n指定拦截 QQ号 (当前群绑定给该主人)';
            }

            const targetQQ = match[1];
            const targetGroup = match[2] || currentGroupId;

            if (!targetGroup) {
                return '❌ 必须在群内使用，或者显式提供群号：指定拦截 QQ号 群号';
            }

            if (!owners.includes(targetQQ)) {
                return `❌ 设置失败：${targetQQ} 不在主人列表中。`;
            }

            db.prepare('INSERT OR REPLACE INTO exclusive_push (user_id, group_id) VALUES (?, ?)').run(targetQQ, targetGroup);
            return `✅ 设置成功！\n主人 ${targetQQ} 现在起【只接收群 ${targetGroup}】的撤回通知，其他群的撤回将被屏蔽。`;
        }

        // ==========================================
        // 2. 取消拦截
        // ==========================================
        if (cmd.startsWith('取消拦截')) {
            const content = cmd.replace('取消拦截', '').trim();
            const match = content.match(/^(\d{5,12})$/);
            
            const targetQQ = match ? match[1] : senderQQ;

            if (!owners.includes(targetQQ)) {
                return `❌ 失败：${targetQQ} 不在主人列表中。`;
            }

            const info = db.prepare('DELETE FROM exclusive_push WHERE user_id = ?').run(targetQQ);
            if (info.changes > 0) {
                return `✅ 已取消！主人 ${targetQQ} 恢复接收所有群的撤回通知。`;
            } else {
                return `⚠️ 主人 ${targetQQ} 当前没有设置专属拦截。`;
            }
        }

        // ==========================================
        // 3. 查看拦截
        // ==========================================
        if (cmd.startsWith('查看拦截')) {
            const rows = db.prepare('SELECT user_id, group_id FROM exclusive_push').all();
            if (rows.length === 0) {
                return '⚙️ 当前没有任何主人设置专属拦截，所有撤回消息默认推送给全部主人。';
            }
            
            let reply = '⚙️ 当前专属拦截绑定列表：\n';
            rows.forEach(r => {
                reply += `👤 主人 ${r.user_id} ➡️ 只听群 ${r.group_id}\n`;
            });
            return reply.trim();
        }
    }

    // ==========================================
    // 4. 普通消息缓存逻辑 (必须放在最后)
    // ==========================================
    if (raw.post_type === 'message' && raw.message_id) {
        if (senderQQ === String(msg.botId)) return false; // 忽略自己

        backupCache.set(raw.message_id, {
            name: msg.senderName || '未知',
            senderId: senderQQ,
            groupId: currentGroupId,
            groupName: msg.isGroup ? (raw.group_name || null) : null,
            content: raw.message || [] 
        });
        
        setTimeout(() => backupCache.delete(raw.message_id), CACHE_TIME);
    }
    return false; 
  },

  // ==========================================
  // 5. 接收撤回事件并发通知
  // ==========================================
  async onEvent(eventData, context) {
    const config = this.loadConfig();
    if (config.enabled === false) return;

    const raw = eventData.raw;
    if (!raw) return;

    if (raw.notice_type === 'group_recall' || raw.notice_type === 'friend_recall') {
        const backup = backupCache.get(raw.message_id);
        
        if (backup) {
            let locationStr = '私聊';
            const currentGroupId = backup.groupId; 
            
            if (currentGroupId) {
                let gName = backup.groupName;
                if (!gName) {
                    try {
                        const res = await fetch(`http://127.0.0.1:3000/get_group_info?group_id=${currentGroupId}`);
                        const data = await res.json();
                        if (data.data && data.data.group_name) gName = data.data.group_name;
                    } catch (e) {}
                }
                locationStr = gName ? `${gName}(${currentGroupId})` : `群聊(${currentGroupId})`;
            }

            const allOwners = this.getOwners();
            if (allOwners.length === 0) return;

            const alertText = config.alert_text || '🛑 【防撤回拦截】\n';
            const sendMsg = [
                { type: 'text', data: { text: `${alertText}来源：${locationStr}\n发送者：${backup.name}(${backup.senderId})\n内容：\n` } },
                ...backup.content
            ];

            // 🌟 核心逻辑：遍历每一个主人，判断是否该发给他
            for (const owner of allOwners) {
                if (owner === backup.senderId) continue; // 不发给撤回者自己

                // 查数据库，看这个主人有没有专属绑定
                const boundGroup = db.prepare('SELECT group_id FROM exclusive_push WHERE user_id = ?').get(owner);
                
                let shouldSend = false;

                if (boundGroup && boundGroup.group_id) {
                    // 如果这个主人绑定了专属群
                    if (currentGroupId === boundGroup.group_id) {
                        shouldSend = true; // 当前撤回的正好是他绑定的群，发！
                    }
                } else {
                    // 如果这个主人没有绑定专属群，默认接收全部
                    shouldSend = true;
                }

                if (shouldSend && globalThis._ws && globalThis._ws.readyState === 1) {
                    globalThis._ws.send(JSON.stringify({
                        action: 'send_msg',
                        params: {
                            message_type: 'private',
                            user_id: Number(owner), 
                            message: sendMsg
                        },
                        echo: Date.now()
                    }));
                }
            }
            backupCache.delete(raw.message_id);
        }
    }
  }
};