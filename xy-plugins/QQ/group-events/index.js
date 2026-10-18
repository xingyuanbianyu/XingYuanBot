// xy-plugins/QQ/group-events/index.js
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getConfig() {
  const raw = fs.readFileSync(
      path.join(__dirname, '../../../temp/vris/vris.yaml'),
      'utf-8'
  );
  return yaml.parse(raw);
}

function getBotConfig() {
  try {
    const raw = fs.readFileSync(
        path.join(__dirname, '../../../xy-data/config.yaml'),
        'utf-8'
    );
    const parsed = yaml.parse(raw) || {};
    return {
      blacklist_group: (parsed.blacklist_group || []).map(String),
      // 🌟 新增：读取事件插件全局开关（默认开启）
      eventEnabled: parsed.group_events?.enabled !== false,
      // 🌟 新增：单独控制入群和退群提示（默认开启）
      welcomeEnabled: parsed.group_events?.welcome !== false,
      decreaseEnabled: parsed.group_events?.decrease !== false
    };
  } catch (e) {
    return { blacklist_group: [], eventEnabled: true, welcomeEnabled: true, decreaseEnabled: true };
  }
}

function render(key, vars) {
  const tpl = getConfig()[key];
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

async function getGroupName(groupId, userId) {
  try {
    const res = await fetch('http://127.0.0.1:3000/get_group_member_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId, user_id: userId, no_cache: false }),
    });
    const data = await res.json();
    return data.data?.card || data.data?.nickname || null;
  } catch (e) {
    return null;
  }
}

export default {
  name: 'group-events',
  events: ['group.increase', 'group.decrease', 'group.kick'],

  async onEvent(e, conn) {
    const botConfig = getBotConfig();

    // 🌟 核心开关：如果总开关关了，直接死掉，不往下走
    if (!botConfig.eventEnabled) return;

    // 🌟 独立开关控制
    if (e.event === 'group.increase' && !botConfig.welcomeEnabled) return;
    if (e.event !== 'group.increase' && !botConfig.decreaseEnabled) return;

    // 只检查群黑名单
    if (botConfig.blacklist_group.includes(String(e.groupId))) return;

    const key = e.event === 'group.increase' ? 'welcome'
        : e.event === 'group.kick'     ? 'kick'
            : 'decrease';

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

    const payload = {
      action: 'send_msg',
      params: {
        message_type: 'group',
        group_id: e.groupId,
        message: parseMessage(msg),
      },
    };

    if (conn?.ws) {
      conn.ws.send(JSON.stringify(payload));
      console.log(`✅ [${key}] → 群 ${e.groupId}: ${msg}`);
    }
  },
};