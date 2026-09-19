import { generateHelpCard } from './card.js';
import { pathToFileURL } from 'url';
import fs from 'fs';
import { manageBlacklist } from '../../../xy-bot/blacklist.js';
import { hasPermission, getRole } from '../../../xy-config/config/permissions.js';

export default {
  name: '指令',

  // ✅ match 直接接收字符串 text
  match: (text) => {
    if (typeof text !== 'string') return false;

    // 1. 检查是否有前缀
    const hasPrefix = text.startsWith('#') || text.startsWith('/');
    if (!hasPrefix) return false;

    // 2. 剥离前缀
    const pureText = text.replace(/^#|^\//, '').trim();

    // 3. 精确匹配：必须完全等于这些词
    return pureText === '帮助' ||
        pureText === '状态' ||
        pureText === '退出' ||
        pureText === '权限' ||
        pureText === '重启' ||
        pureText === '重载' ||
        pureText === '拉黑' ||
        pureText === '取消';
  },

  handle: async (msgObj) => {
        // 1. 先用 parseMsg 拿其他字段
        const { text, chatId, isGroup, senderName } = parseMsg(msgObj);
        const pureText = text.replace(/^#|^\//, '').trim();

        // 2. 暴力提取 QQ 号（兼容各种可能的字段名：user_id / userId / qq / senderId）
        const rawQQ = msgObj.user_id || msgObj.userId || msgObj.qq || (msgObj.sender && (msgObj.sender.user_id || msgObj.sender.userId)) || msgObj.senderId;
        const senderId = String(rawQQ); // 强制转成字符串，跟配置文件对齐

        // 如果还是拿不到，打个警告
        if (!senderId) {
            console.error('⚠️ 无法从 msgObj 中提取发送者 QQ 号！msgObj:', msgObj);
            return null;
        }

    // ==========================================
    // [ #拉黑 / #取消 ] 指令
    // ==========================================
    if (typeof text === 'string' && (pureText === '拉黑' || pureText == '取消')) {
      // 仅大主人、小主人可用
      if (!hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
        return '❌ 权限不足：仅主人可管理黑名单。';
      }

      const { manageBlacklist } = await import('../../../xy-bot/blacklist.js');
      const match = text.match(/(?:拉黑|取消)\s*(\d{5,13})\s+([01])$/);

      if (!match) {
        const looseMatch = text.match(/(?:拉黑|取消)\s*(\d{5,13})\s+(.+)$/);
        if (looseMatch && looseMatch[2] !== '0' && looseMatch[2] !== '1') {
          return `❌ 末尾参数错误：'${looseMatch[2]}'，只允许 0（用户）或 1（群）。`;
        }
        return '❌ 格式错误，例如：#拉黑 123456 0（拉黑用户）或 #拉黑 123456 1（拉黑群）';
      }

      const target = match[1];
      const flag = match[2];
      const type = flag === '1' ? 'group' : 'qq';
      const isAdd = pureText('拉黑');

      return manageBlacklist(type, target, isAdd);
    }

    // ==========================================
    // [ #权限 ] 指令
    // ==========================================
    if (pureText === '权限') {
      const roleMap = {
        master: '👑 大主人（最高权限）',
        owner:  '🌟 小主人（主人权限）',
        admin:  '🛡 管理员',
        member: '👤 普通成员'
      };
        // 直接拿到 'master'/'owner'/'admin'/'member' 字符串
        const userRole = getRole(senderId);
        return `【${senderName}】的权限等级：${roleMap[userRole] || '未知'}`;
    }

    // ==========================================
    // [ #帮助 ] 指令
    // ==========================================
    if (pureText === '帮助') {
      try {
        const imagePath = await generateHelpCard();
        const buffer = fs.readFileSync(imagePath);
        return { file: buffer };
      } catch (e) {
        console.error('生成帮助卡片失败:', e);
        return '❌ 获取帮助失败';
      }
    }

    // ==========================================
    // [ #状态 ] 指令
    // ==========================================
    if (pureText === '状态') {
      // 管理员及以上可用
      if (!hasPermission(senderId, 'admin') && !hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
        return '❌ 权限不足：该指令仅限管理员及以上身份使用。';
      }
      // 自动计算内存与运行时间
      const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
      const uptime = Math.round(process.uptime());
      return `运行状态：正常\n内存占用：${mem} MB\n运行时间：${uptime} 秒`;
    }

      // ==========================================
      // [ #重启 ] 指令
      // ==========================================
      if (pureText === '重启') {
        if (!hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
          return '❌ 权限不足：仅主人可执行重启操作。';
        }

        // 框架会自动把 return 的内容发出去，发完后再执行重启
        setTimeout(async () => {
          const { spawn } = await import('child_process');
          const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
          const pyProcess = spawn(pythonCmd, ['script.py', process.pid.toString()], {
            detached: true,
            stdio: 'ignore'
          });
          pyProcess.unref();
          setTimeout(() => { process.exit(0); }, 2000);
        }, 1000); // 等1秒让消息发出去再重启

        return '🔷 机器人正在重启，请稍候...';
      }

      // ==========================================
    // [ #重载 ] 指令
    // ==========================================
    if (pureText === '重载') {
      if (!hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
        return '❌ 权限不足：仅主人可执行重载操作。';
      }

      try {
        const loaderURL = new URL('../../../xy-bot/plugin-loader.js', import.meta.url).href;
        const { loadPlugins } = await import(loaderURL);

        if (typeof globalThis._xyReloadPlugins === 'function') {
          const reloaded = await globalThis._xyReloadPlugins();
          return `✅ 已重新加载 ${reloaded.length} 个插件！`;
        } else {
          return '❌ 重载入口未配置，请先在 adapter.js 中注册全局重载函数。';
        }
      } catch (e) {
        return '❌ 重载失败：' + e.message;
      }
    }

      // ==========================================
      // [ #退出 ] 指令
      // ==========================================
      if (pureText === '退出') {
        if (!hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
          return '❌ 权限不足：仅主人可执行关闭操作。';
        }

        // 延迟 1.5 秒执行退出，先让 return 的消息发送出去
        setTimeout(() => {
          process.exit(0);
        }, 1500);

        return '🔷 机器人已关闭。';
      }
      return null;
  }
};
