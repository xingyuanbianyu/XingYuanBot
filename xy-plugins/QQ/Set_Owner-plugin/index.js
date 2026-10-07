import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 保留你原本的写法，因为作为插件，cwd 绝对是根目录，没毛病！
const CONFIG_PATH = path.join(process.cwd(), 'xy-config', 'config', 'config.yaml');

const verificationCodes = new Map();
const CODE_EXPIRE = 5 * 60 * 1000;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return yaml.parse(content) || {};
  } catch (e) {
    console.error('[权限插件] config.yaml 解析失败:', e.message);
    return {}; // 防止解析失败导致插件崩溃
  }
}

function saveConfig(config) {
  try {
    const content = yaml.stringify(config);
    fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
  } catch (e) {
    console.error('[权限插件] 写入配置失败:', e.message);
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
    const trimmed = (text || '').trim();
    return /^(设置主人|设置小主人|取消主人|权限状态)/.test(trimmed);
  },

  async handle(std) {
    const text = (std.content ?? std.text ?? '').trim();
    // 【修复】强制把发送者QQ转为字符串，避免后续类型混乱
    const senderQQ = String(std.senderId ?? std.senderQQ ?? '');
    const role = std.role;

    if (!text) return null;

    const args = text.split(/\s+/);
    const cmd = args[0];

    try {
      if (cmd === '设置主人') {
        return await this.handleSetMaster(args, senderQQ, role);
      } else if (cmd === '设置小主人') {
        return await this.handleSetOwner(args, senderQQ, role);
      } else if (cmd === '取消主人') {
        return await this.handleRemoveOwner(args, senderQQ, role);
      } else if (cmd === '权限状态') {
        return await this.handlePermission(args, senderQQ, role);
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
        // 【修复】存的时候强制转字符串
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
        const code = args[2].toUpperCase();
        // 【核心修复】直接通过 senderQQ 获取验证码（你给谁设置，就用谁的验证码）
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
        // 注意：这里使用的是 args[1] 作为目标QQ，即你想把谁设置为主人
        config.permissions.owners[String(args[1])] = true;
        config.permissions.permission_switch[String(args[1])] = 1;
        saveConfig(config);
        verificationCodes.delete(String(senderQQ));

        return '✅ 验证成功，你已经是大主人了';

      } else {
        return '📌 指令格式：设置主人 <QQ号> <验证码>';
      }
    } else {
      if (senderQQ !== masterQQ) {
        return '❌ 已有大主人，只有大主人才能设置小主人';
      }
      return '📌 请使用"设置小主人 <QQ号>"指令来设置小主人';
    }
  },

  async handleSetOwner(args, senderQQ, role) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (senderQQ !== masterQQ) {
      return '❌ 只有大主人可以设置小主人';
    }

    if (args.length < 2) {
      return '📌 指令格式：设置小主人 <QQ号>';
    }

    const targetQQ = String(args[1]);
    if (!/^\d{5,11}$/.test(targetQQ)) {
      return '❌ QQ号格式不正确';
    }

    ensurePermissions(config);
    config.permissions.owners[targetQQ] = false;
    config.permissions.permission_switch[targetQQ] = 0;
    saveConfig(config);

    return `✅ 已将 ${targetQQ} 设置为小主人（默认权限关闭，请使用"权限状态 开 ${targetQQ}"开启）`;
  },

  async handleRemoveOwner(args, senderQQ, role) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (senderQQ !== masterQQ) {
      return '❌ 只有大主人可以取消主人';
    }

    if (args.length < 2) {
      return '📌 指令格式：取消主人 <QQ号>';
    }

    const targetQQ = String(args[1]);
    if (targetQQ === masterQQ) {
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

  async handlePermission(args, senderQQ, role) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (args.length < 2) {
      return '📌 指令格式：权限状态 <开/关/查询> [QQ号]';
    }

    const action = args[1];
    const targetQQ = args[2] ? String(args[2]) : null;

    if (action === '查询') {
      if (!targetQQ) return '📌 指令格式：权限状态 查询 <QQ号>';

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

    if (senderQQ !== masterQQ) {
      return '❌ 只有大主人可以修改权限状态';
    }

    if (!targetQQ) {
      return `📌 指令格式：权限状态 ${action} <QQ号>`;
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