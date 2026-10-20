import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const GLOBAL_CONFIG_PATH = path.join(process.cwd(), 'xy-config/config/config.yaml');

const backupCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;

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
            groupName: msg.isGroup ? (msg.rawData?.group_name || null) : null, // 尽量提前缓存群名（部分协议端会带）
            content: msg.message || [] 
        });
        
        setTimeout(() => backupCache.delete(msg.message_id), CACHE_TIME);
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
            
            // 🌟 核心修改：如果是群聊，去请求 API 获取真实群名
            if (backup.groupId) {
                let gName = backup.groupName;
                if (!gName) {
                    try {
                        // 调用 NapCat HTTP API 获取群信息
                        const res = await fetch(`http://127.0.0.1:3000/get_group_info?group_id=${backup.groupId}`);
                        const data = await res.json();
                        if (data.data && data.data.group_name) {
                            gName = data.data.group_name;
                        }
                    } catch (e) {
                        console.log(`[防撤回] 获取群名 API 请求失败，将使用群号代替`);
                    }
                }
                locationStr = gName ? `${gName}(${backup.groupId})` : `群聊(${backup.groupId})`;
            }

            const alertText = config.alert_text || '🛑 【防撤回拦截】\n';
            // 格式化最终文本：显示名字 + 括号内的号码
            const sendMsg = [
                { type: 'text', data: { text: `${alertText}来源：${locationStr}\n发送者：${backup.name}(${backup.senderId})\n内容：\n` } },
                ...backup.content
            ];

            for (const owner of owners) {
                if (owner === backup.senderId) continue; 

                if (globalThis._ws && globalThis._ws.readyState === 1) {
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