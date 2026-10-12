import { generateHelpCard } from './card.js';
import { pathToFileURL } from 'url';
import fs from 'fs';
// 🌟 修复路径：../../../ 改为 ../../
import { manageBlacklist } from '../../../xy-bot/blacklist.js';
import { hasPermission, getRole } from '../../../xy-config/config/permissions.js';

export default {
  name: '指令',

  // ✅ match 直接接收字符串 text
  match: (text) => {
    if (typeof text !== 'string') return false;

    // 1. 🌟 严格前置检查：必须有前缀，绝对不能省略！
    const hasPrefix = text.startsWith('#') || text.startsWith('/');
    if (!hasPrefix) return false;

    // 2. 剥离前缀
    const pureText = text.replace(/^#|^\//, '').trim();
    if (!pureText) return false;

    // 3. 🌟 类型匹配（取代原来的正则匹配）
    // 只要剥离前缀后，是以“拉黑”或“取消”开头，就放行给 handle 处理
    // 这样既保证了“必须有前缀才触发”，也不会因为长文本中的“取消”误触
    const isBlacklistCmd = pureText.startsWith('拉黑') || pureText.startsWith('取消');

    return pureText === '帮助' ||
        pureText === '状态' ||
        pureText === '退出' ||
        pureText === '权限' ||
        pureText === '重启' ||
        pureText === '重载' ||
        isBlacklistCmd;
  },

  handle: async (msgObj) => {
        // 1. 安全解析 msgObj
        let text = '', chatId = '', isGroup = false, senderName = '未知';
        if (typeof parseMsg === 'function') {
            ({ text, chatId, isGroup, senderName } = parseMsg(msgObj));
        } else {
            text = msgObj.content || msgObj.text || msgObj.raw_message || '';
            chatId = msgObj.group_id || msgObj.user_id || '';
            isGroup = msgObj.message_type === 'group';
            senderName = msgObj.sender?.nickname || '未知';
        }

        const pureText = text.replace(/^#|^\//, '').trim();

        // 2. 暴力提取 QQ 号
        const rawQQ = msgObj.user_id || msgObj.userId || msgObj.qq || (msgObj.sender && (msgObj.sender.user_id || msgObj.sender.userId)) || msgObj.senderId;
        const senderId = rawQQ ? String(rawQQ) : '';

        if (!senderId) {
            console.error('⚠️ 无法从 msgObj 中提取发送者 QQ 号！');
            return null;
        }

        // ==========================================
        // [ #拉黑 / #取消 ] 指令
        // ==========================================
        // 🌟 核心修复：用 pureText 进行类型判断，而不是用 text 去做模糊正则匹配
        if (pureText.startsWith('拉黑') || pureText.startsWith('取消')) {
          
          // 仅大主人、小主人可用
          if (!hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
            return '❌ 权限不足：仅主人可管理黑名单。';
          }

          // 动态导入，避免循环依赖
          const { manageBlacklist } = await import('../../xy-bot/blacklist.js');

          // 严格匹配指令格式：拉黑/取消 + 空格 + 5-13位数字 + 空格 + 0或1
          const match = pureText.match(/^(拉黑|取消)\s*(\d{5,13})\s+([01])$/);

          if (!match) {
            // 错误分支：判断是不是参数填错了
            const looseMatch = pureText.match(/^(?:拉黑|取消)\s*(\d{5,13})\s+(.+)$/);
            if (looseMatch && looseMatch[2] !== '0' && looseMatch[2] !== '1') {
              return `❌ 末尾参数错误：'${looseMatch[2]}'，只允许 0（用户）或 1（群）。`;
            }
            return '❌ 格式错误，例如：#拉黑 123456 0（拉黑用户）或 #拉黑 123456 1（拉黑群）';
          }

          // 4. 提取数据
          const target = match[2];  // 捕获组2：QQ号
          const flag = match[3];    // 捕获组3：0 或 1
          const type = flag === '1' ? 'group' : 'qq';

          // 5. 判断是拉黑还是取消
          const isAdd = match[1] === '拉黑';

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
          if (!hasPermission(senderId, 'admin') && !hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
            return '❌ 权限不足：该指令仅限管理员及以上身份使用。';
          }
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
          setTimeout(async () => {
            const { spawn } = await import('child_process');
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            // 注意：如果是 PM2 环境，Python 脚本会自动检测并交还控制权给 PM2
            const pyProcess = spawn(pythonCmd, ['script.py', process.pid.toString()], {
              detached: true,
              stdio: 'ignore'
            });
            pyProcess.unref();
            setTimeout(() => { process.exit(0); }, 2000);
          }, 1000);
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
            const loaderURL = new URL('../../xy-bot/plugin-loader.js', import.meta.url).href;
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
          setTimeout(() => { process.exit(0); }, 1500);
          return '🔷 机器人已关闭。';
        }

        return null;
  }
};