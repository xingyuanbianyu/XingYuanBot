import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(process.cwd(), 'xy-config', 'config', 'config.yaml');

const verificationCodes = new Map();
const CODE_EXPIRE = 5 * 60 * 1000;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return yaml.parse(content) || {};
  } catch (e) {
    console.error('[权限] 解析 config.yaml 失败:', e.message);
    return null;
  }
}

function saveConfig(config) {
  try {
    const content = yaml.stringify(config);
    fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
  } catch (e) {
    console.error('[权限] 写入 config.yaml 失败:', e.message);
  }
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getMasterQQ(config) {
  const owners = config?.permissions?.owners || {};
  for (const [qq, isMaster] of Object.entries(owners)) {
    if (isMaster === true || isMaster === 'true') return qq;
  }
  return null;
}

function ensurePermissions(config) {
  if (!config.permissions) config.permissions = {};
  if (!config.permissions.owners) config.permissions.owners = {};
  if (!config.permissions.permission_switch) config.permissions.permission_switch = {};
}

export default {
  match(text) {
    if (typeof text !== 'string') return false;
    const pureText = text.trim();
    return pureText.startsWith('设置主人') || 
           pureText.startsWith('设置小主人') || 
           pureText.startsWith('取消主人') || 
           pureText.startsWith('权限状态');
  },

  async handle(msgObj) {
    const text = (msgObj.pureText || msgObj.content || msgObj.text || '').trim();
    const senderQQ = String(msgObj.senderQQ || msgObj.senderId || msgObj.user_id || '');
    const role = msgObj.role || 'member';

    if (!text || !senderQQ) return null;

    // 🌟 核心新增：提取 @ 目标
    let targetQQFromAt = null;
    if (Array.isArray(msgObj.message)) {
        const atItem = msgObj.message.find(item => item?.type === 'at');
        if (atItem && atItem.data && atItem.data.qq) {
            targetQQFromAt = String(atItem.data.qq);
        }
    }

    const args = text.split(/\s+/);
    const cmd = args[0];

    try {
      if (cmd === '设置主人') {
        return await this.handleSetMaster(args, senderQQ, role);
      } else if (cmd === '设置小主人') {
        return await this.handleSetOwner(args, senderQQ, role, targetQQFromAt);
      } else if (cmd === '取消主人') {
        return await this.handleRemoveOwner(args, senderQQ, role, targetQQFromAt);
      } else if (cmd === '权限状态') {
        return await this.handlePermission(args, senderQQ, role, targetQQFromAt);
      }
    } catch (e) {
      console.error('[权限管理插件错误]', e);
      return '操作失败: ' + e.message;
    }
    return null;
  },

  async handleSetMaster(args, senderQQ, role) {
    const config = loadConfig();
    if (!config) return '配置文件不存在';

    const masterQQ = getMasterQQ(config);
    if (!masterQQ) {
      if (args.length === 1) {
        const code = generateCode();
        verificationCodes.set(String(senderQQ), { code, time: Date.now() });

        const makedCode = '*'.repeat(code.length);

        console.log('\n╔══════════════════════════════════════╗');
        console.log('       📌 大主人权限设置验证码');
        console.log(`       QQ号  : ${senderQQ}`);
        console.log(`       验证码: ${code}`);
        console.log(`       指令  : 设置主人 ${senderQQ} ${code}`);
        console.log('╚══════════════════════════════════════╝\n');

        return `✅ 验证码已生成，请在控制台查看，然后发送："设置主人 ${senderQQ} ${makedCode}"（5分钟内有效）`;

      } else if (args.length === 3) {
        const targetQQ = String(args[1]);
        const code = args[2].toUpperCase();
        
        const verify = verificationCodes.get(String(senderQQ));

        if (!verify) return '❌ 验证失败，请重新执行"设置主人"指令';
        if (Date.now() - verify.time > CODE_EXPIRE) {
          verificationCodes.delete(String(senderQQ));
          return '❌ 验证码已过期，请重新执行"设置主人"指令';
        }
        if (verify.code !== code) {
          return '❌ 验证失败，请重新验证';
        }

        ensurePermissions(config);
        config.permissions.owners[targetQQ] = true;
        config.permissions.permission_switch[targetQQ] = 1;
        saveConfig(config);
        verificationCodes.delete(String(senderQQ));

        return '✅ 验证成功，你已经是大主人了';

      } else {
        return '📌 指令格式：设置主人 <QQ号> <验证码>';
      }
    } else {
      if (String(senderQQ) !== String(masterQQ)) {
        return '❌ 已有大主人，只有大主人才能设置小主人';
      }
      return '📌 请使用"设置小主人 <QQ号> 或 @某人"指令来设置小主人';
    }
  },

  // 🌟 修改：支持 targetQQFromAt
  async handleSetOwner(args, senderQQ, role, targetQQFromAt) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (String(senderQQ) !== String(masterQQ)) {
      return '❌ 只有大主人可以设置小主人';
    }

    // 优先使用 @ 提取的 QQ，其次用参数
    let targetQQ = targetQQFromAt;
    if (!targetQQ && args.length >= 2) targetQQ = String(args[1]);
    
    if (!targetQQ) {
      return '📌 指令格式：设置小主人 <QQ号> 或 @某人';
    }

    if (!/^\d{5,12}$/.test(targetQQ)) {
      return '❌ QQ号格式不正确';
    }

    ensurePermissions(config);
    config.permissions.owners[targetQQ] = false;
    config.permissions.permission_switch[targetQQ] = 0;
    saveConfig(config);

    return `✅ 已将 ${targetQQ} 设置为小主人（默认权限关闭，请使用"权限状态 开 ${targetQQ}"开启）`;
  },

  // 🌟 修改：支持 targetQQFromAt
  async handleRemoveOwner(args, senderQQ, role, targetQQFromAt) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (String(senderQQ) !== String(masterQQ)) {
      return '❌ 只有大主人可以取消主人';
    }

    let targetQQ = targetQQFromAt;
    if (!targetQQ && args.length >= 2) targetQQ = String(args[1]);

    if (!targetQQ) {
      return '📌 指令格式：取消主人 <QQ号> 或 @某人';
    }

    if (targetQQ === String(masterQQ)) {
      return '❌ 不能取消大主人的身份';
    }

    const owners = config.permissions?.owners || {};
    if (owners[targetQQ] === undefined) {
      return `❌ ${targetQQ} 不是主人`;
    }

    delete config.permissions.owners[targetQQ];
    delete config.permissions.permission_switch[targetQQ];
    saveConfig(config);

    return `✅ 已取消 ${targetQQ} 的主人身份`;
  },

  // 🌟 修改：支持 targetQQFromAt
  async handlePermission(args, senderQQ, role, targetQQFromAt) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (args.length < 2) {
      return '📌 指令格式：权限状态 <开/关/查询> <QQ号> 或 @某人';
    }

    const action = args[1];
    
    // 优先使用 @ 提取的 QQ，其次用参数
    let targetQQ = targetQQFromAt;
    if (!targetQQ && args.length >= 3) targetQQ = String(args[2]);

    if (action === '查询') {
      if (!targetQQ) return '📌 指令格式：权限状态 查询 <QQ号> 或 @某人';

      const owners = config.permissions?.owners || {};
      const permSwitch = config.permissions?.permission_switch || {};

      if (owners[targetQQ] === undefined) {
        return `❌ ${targetQQ} 不是主人`;
      }
      if (owners[targetQQ] === true || owners[targetQQ] === 'true') {
        return `📌 ${targetQQ} 是大主人，权限永久开启（不可关闭）`;
      }

      const status = Number(permSwitch[targetQQ]) === 1 ? '✅ 开启' : '❌ 关闭（失效）';
      return `📌 ${targetQQ} 是小主人，当前权限状态：${status}`;
    }

    if (String(senderQQ) !== String(masterQQ)) {
      return '❌ 只有大主人可以修改权限状态';
    }

    if (!targetQQ) {
      return `📌 指令格式：权限状态 ${action} <QQ号> 或 @某人`;
    }

    const owners = config.permissions?.owners || {};

    if (owners[targetQQ] === undefined) {
      return `❌ ${targetQQ} 不是主人`;
    }
    if (owners[targetQQ] === true || owners[targetQQ] === 'true') {
      return '❌ 不能修改大主人的权限状态';
    }

    ensurePermissions(config);

    if (action === '开') {
      config.permissions.permission_switch[targetQQ] = 1;
      saveConfig(config);
      return `✅ 已开启 ${targetQQ} 的权限`;
    } else if (action === '关') {
      config.permissions.permission_switch[targetQQ] = 0;
      saveConfig(config);
      return `✅ 已关闭 ${targetQQ} 的权限`;
    } else {
      return '❌ 未知操作，请使用：开 / 关 / 查询';
    }
  }
};