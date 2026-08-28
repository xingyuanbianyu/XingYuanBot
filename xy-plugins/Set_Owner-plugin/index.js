import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 从插件目录回到 bot 根目录，再定位到 config.yaml
const CONFIG_PATH = path.join(process.cwd(), 'xy-config', 'config', 'config.yaml');

// 存储待验证的验证码：Map<qq号, {code, time}>
const verificationCodes = new Map();
const CODE_EXPIRE = 5 * 60 * 1000; // 5分钟过期

// ============ 配置文件操作 ============

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return yaml.parse(content);
}

function saveConfig(config) {
  const content = yaml.stringify(config);
  fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
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
    if (isMaster === true) return qq;
  }
  return null;
}

function ensurePermissions(config) {
  if (!config.permissions) config.permissions = {};
  if (!config.permissions.owners) config.permissions.owners = {};
  if (!config.permissions.permission_switch) config.permissions.permission_switch = {};
}

// ============ 插件入口 ============

export default {
  match(text) {
    const trimmed = text?.trim() || '';
    return /^(设置主人|设置小主人|取消主人|权限状态)/.test(trimmed);
  },

  async handle({ text, senderQQ, role }) {
    const trimmed = text.trim();
    const args = trimmed.split(/\s+/);
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

  // ---- 设置主人（大主人验证 / 已有大主人时提示设置小主人） ----
  async handleSetMaster(args, senderQQ, role) {
    const config = loadConfig();
    if (!config) return '配置文件不存在';

    const masterQQ = getMasterQQ(config);

    if (!masterQQ) {
      // 还没有大主人，进入验证流程
      if (args.length === 1) {
        // 第一次触发：生成验证码
        const code = generateCode();
        verificationCodes.set(senderQQ, { code, time: Date.now() });

        console.log('\n╔══════════════════════════════════════╗');
        console.log('       📌 大主人权限设置验证码');
        console.log(`       QQ号  : ${senderQQ}`);
        console.log(`       验证码: ${code}`);
        console.log(`       指令  : 设置主人 ${senderQQ} ${code}`);
        console.log('╚══════════════════════════════════════╝\n');

        return `✅ 验证码已生成，请在控制台查看，然后发送："设置主人 ${senderQQ} ${code}"（5分钟内有效）`;

      } else if (args.length === 3) {
        // 验证阶段：设置主人 <QQ> <验证码>
        const qq = args[1];
        const code = args[2].toUpperCase();
        const verify = verificationCodes.get(qq);

        if (!verify) return '❌ 验证失败，请重新执行"设置主人"指令';
        if (Date.now() - verify.time > CODE_EXPIRE) {
          verificationCodes.delete(qq);
          return '❌ 验证码已过期，请重新执行"设置主人"指令';
        }
        if (verify.code !== code) {
          return '❌ 验证失败，请重新验证';
        }

        // 验证成功，写入大主人
        ensurePermissions(config);
        config.permissions.owners[qq] = true;
        config.permissions.permission_switch[qq] = 1;
        saveConfig(config);
        verificationCodes.delete(qq);

        return '✅ 验证成功，你已经是大主人了';

      } else {
        return '📌 指令格式：设置主人 <QQ号> <验证码>';
      }
    } else {
      // 已有大主人
      if (String(senderQQ) !== masterQQ) {
        return '❌ 已有大主人，只有大主人才能设置小主人';
      }
      return '📌 请使用"设置小主人 <QQ号>"指令来设置小主人';
    }
  },

  // ---- 设置小主人（仅大主人可用） ----
  async handleSetOwner(args, senderQQ, role) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (String(senderQQ) !== masterQQ) {
      return '❌ 只有大主人可以设置小主人';
    }

    if (args.length < 2) {
      return '📌 指令格式：设置小主人 <QQ号>';
    }

    const targetQQ = args[1];
    if (!/^\d{5,11}$/.test(targetQQ)) {
      return '❌ QQ号格式不正确';
    }

    ensurePermissions(config);
    config.permissions.owners[targetQQ] = false;       // 小主人标记
    config.permissions.permission_switch[targetQQ] = 0; // 默认权限关闭
    saveConfig(config);

    return `✅ 已将 ${targetQQ} 设置为小主人（默认权限关闭，请使用"权限状态 开 ${targetQQ}"开启）`;
  },

  // ---- 取消主人（仅大主人可用，不能取消自己） ----
  async handleRemoveOwner(args, senderQQ, role) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (String(senderQQ) !== masterQQ) {
      return '❌ 只有大主人可以取消主人';
    }

    if (args.length < 2) {
      return '📌 指令格式：取消主人 <QQ号>';
    }

    const targetQQ = args[1];

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

  // ---- 权限状态（开/关/查询） ----
  async handlePermission(args, senderQQ, role) {
    const config = loadConfig();
    const masterQQ = getMasterQQ(config);

    if (args.length < 2) {
      return '📌 指令格式：权限状态 <开/关/查询> [QQ号]';
    }

    const action = args[1];
    const targetQQ = args[2];

    // ===== 查询（任何人可查） =====
    if (action === '查询') {
      if (!targetQQ) return '📌 指令格式：权限状态 查询 <QQ号>';

      const owners = config.permissions?.owners || {};
      const permSwitch = config.permissions?.permission_switch || {};

      if (owners[targetQQ] === undefined) {
        return `❌ ${targetQQ} 不是主人`;
      }
      if (owners[targetQQ] === true) {
        return `📌 ${targetQQ} 是大主人，权限永久开启（不可关闭）`;
      }

      const status = permSwitch[targetQQ] === 1 ? '✅ 开启' : '❌ 关闭（失效）';
      return `📌 ${targetQQ} 是小主人，当前权限状态：${status}`;
    }

    // ===== 开 / 关（仅大主人可用） =====
    if (String(senderQQ) !== masterQQ) {
      return '❌ 只有大主人可以修改权限状态';
    }

    if (!targetQQ) {
      return `📌 指令格式：权限状态 ${action} <QQ号>`;
    }

    const owners = config.permissions?.owners || {};

    if (owners[targetQQ] === undefined) {
      return `❌ ${targetQQ} 不是主人`;
    }
    if (owners[targetQQ] === true) {
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
