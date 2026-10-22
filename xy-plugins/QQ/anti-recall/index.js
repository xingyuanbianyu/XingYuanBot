import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
// 🌟 优化路径解析，增加容错
const GLOBAL_CONFIG_PATH = path.resolve(process.cwd(), 'xy-config', 'config', 'config.yaml');

const backupCache = new Map();
const CACHE_TIME = 5 * 60 * 1000; // 5分钟

export default {
  name: '防撤回',
  events: ['group.recall', 'friend.recall'],

  loadConfig() {
    try { return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) { return {}; }
  },

  getOwners() {
    try {
      if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return [];
      const authConfig = yaml.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) || {};
      const ownersObj = authConfig.permissions?.owners || {};
      const permStatus = authConfig.permissions?.permission_switch || {};
      const validOwners = [];

      for (const [qq, isMaster] of Object.entries(ownersObj)) {
          const qqStr = String(qq).trim();
          if (!qqStr) continue;
          if (isMaster === true || isMaster === 'true') {
              validOwners.push(qqStr);
          } else {
              if (permStatus[qqStr] !== 0) validOwners.push(qqStr);
          }
      }
      return [...new Set(validOwners)];
    } catch (e) { return []; }
  },

  async handle(msg) {
    const config = this.loadConfig();
    if (config.enabled === false) return false;

    if (msg.post_type === 'message' && msg.message_id) {
        if (String(msg.senderQQ) === String(msg.botId)) return false;

        backupCache.set(msg.message_id, {
            name: msg.senderName || '未知',
            senderId: String(msg.senderQQ),
            groupId: msg.isGroup ? msg.chatId : null,
            groupName: msg.isGroup ? (msg.rawData?.group_name || null) : null,
            content: msg.message || [] 
        });
        
        // 🌟 增加 unref()，防止这个定时器阻止 Node.js 进程正常退出
        setTimeout(() => backupCache.delete(msg.message_id), CACHE_TIME).unref();
    }
    return false; 
  },

  async onEvent(eventData, context) {
    const config = this.loadConfig();
    if (config.enabled === false) return;

    const raw = eventData.raw;
    if (!raw) return;

    if (raw.notice_type === 'group_recall' || raw.notice_type === 'friend_recall') {
        const backup = backupCache.get(raw.message_id);
        
        if (backup) {
            const owners = this.getOwners();
            if (owners.length === 0) return;

            let locationStr = '私聊';
            
            // 🌟 核心升级：如果是群聊，使用 wsCall 获取真实群名，彻底告别 HTTP
            if (backup.groupId) {
                let gName = backup.groupName;
                if (!gName && typeof globalThis.wsCall === 'function') {
                    try {
                        const data = await globalThis.wsCall('get_group_info', { group_id: backup.groupId });
                        if (data.data && data.data.group_name) {
                            gName = data.data.group_name;
                        }
                    } catch (e) {
                        // wsCall 超时或报错时忽略
                    }
                }
                locationStr = gName ? `${gName}(${backup.groupId})` : `群聊(${backup.groupId})`;
            }

            const alertText = config.alert_text || '🛑 【防撤回拦截】\n';
            const sendMsg = [
                { type: 'text', data: { text: `${alertText}来源：${locationStr}\n发送者：${backup.name}(${backup.senderId})\n内容：\n` } },
                ...backup.content
            ];

            for (const owner of owners) {
                if (owner === backup.senderId) continue; 

                // 🌟 核心升级：使用 wsCall 统一发送私聊消息
                if (typeof globalThis.wsCall === 'function') {
                    try {
                        await globalThis.wsCall('send_private_msg', {
                            user_id: Number(owner), 
                            message: sendMsg
                        });
                    } catch (e) {
                        console.log(`[防撤回] 向主人 ${owner} 发送通知失败: ${e.message}`);
                    }
                }
            }
            backupCache.delete(raw.message_id);
        }
    }
  }
};