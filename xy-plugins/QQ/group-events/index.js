// xy-plugins/QQ/group-events/index.js
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🌟 核心：精准指向配置插件生成的数据库文件
const SHARED_DB_PATH = path.resolve(__dirname, '../../plugins/event-settings/group_data.db');

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

// 🌟 跨目录读取数据库配置
function getGroupSettings(groupId) {
    const gid = String(groupId);
    let settings = { welcome: 1, decrease: 1, kick: 1 }; // 默认全开
    
    if (typeof globalThis.db === 'function') {
        const res = globalThis.db('find', {
            dbPath: SHARED_DB_PATH, // 👈 绝杀，直接读那个文件
            table: 'group_event_settings', 
            where: 'group_id = ?', 
            params: [gid], 
            all: false
        });
        if (res && res.success && res.data) {
            settings = { welcome: res.data.welcome, decrease: res.data.decrease, kick: res.data.kick };
        }
    }
    return settings;
}

function render(key, vars) {
  const tpl = getTemplateConfig()[key];
  if (!tpl) return null;
  let s = tpl;
  s = s.replace(/\{qq\}/g, String(vars.qq ?? '未知'));
  s = s.replace(/\{operator\}/g, String(vars.operator ?? '未知'));
  return s;
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

// 🌟 核心升级：使用 wsCall 获取群成员信息
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

    // 读配置
    const groupSets = getGroupSettings(e.groupId);

    const key = e.event === 'group.increase' ? 'welcome'
        : e.event === 'group.kick'     ? 'kick'
            : 'decrease';

    // 拦截判定
    if (key === 'welcome' && !groupSets.welcome) return;
    if (key === 'decrease' && !groupSets.decrease) return;
    if (key === 'kick' && !groupSets.kick) return;

    let qqValue;
    let opValue;
    const raw = e.raw || {};

    if (key === 'welcome') {
      qqValue = raw.nickname || raw.card || await getGroupName(e.groupId, e.userId) || String(e.userId);
    } else {
      qqValue = raw.nickname || raw.card || await getGroupName(e.groupId, e.userId) || String(e.userId);
    }

    if (e.operatorId) {
      opValue = raw.operator_nickname || raw.operator_card || await getGroupName(e.groupId, e.operatorId) || String(e.operatorId);
    }

    const msg = render(key, { qq: qqValue, operator: opValue });
    if (!msg) return;

    // 🌟 核心升级：抛弃 conn.ws.send，全部走统一的 wsCall，自带超时和错误捕获
    if (typeof globalThis.wsCall === 'function') {
        try {
            await globalThis.wsCall('send_msg', {
                message_type: 'group',
                group_id: Number(e.groupId),
                message: parseMessage(msg),
            });
            console.log(`✅ [${key}] → 群 ${e.groupId}: ${msg}`);
        } catch (err) {
            console.error(`❌ [群事件] 发送消息到群 ${e.groupId} 失败: ${err.message}`);
        }
    } else {
        console.error('❌ [群事件] wsCall 未就绪，无法发送消息');
    }
  },
};