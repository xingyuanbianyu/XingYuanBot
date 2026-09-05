import { generateHelpCard } from './card.js';
import { pathToFileURL } from 'url';
import fs from 'fs';

export default {
  name: '指令',
  // ✅ 统一加上前缀判断
  match: (text) => {
    const hasPrefix = text.startsWith('#') || text.startsWith('/');
    if (!hasPrefix) return false;
    
    return text.includes('帮助') || text.includes('状态') || text.includes('退出') || text.includes('权限') || text.includes('重启');
  },
  
  handle: async ({ text, chatId, isGroup, senderName, role }) => {

    // ─── [ #权限 ] 指令 ──────────────────────────────────
    if (text.includes('权限')) {
      const roleMap = {
        master: '👑 大主人（最高权限）',
        owner: '🌟 小主人（主人权限）',
        admin:  '🛡️ 管理员',
        member: '👤 普通成员'
      };
      return `【${senderName}】的权限等级：${roleMap[role] || '未知'}`;
    }

    // ─── [ #帮助 ] 指令 ──────────────────────────────────
    if (text.includes('帮助')) {
      const imagePath = await generateHelpCard();
      const buffer = fs.readFileSync(imagePath);
      return { file: { file: buffer }};
    }

    // ─── [ #状态 ] 指令 ──────────────────────────────────
    if (text.includes('状态')) {
      if (role === 'member') {
        return '❌ 权限不足：该指令仅限管理员及以上身份使用。';
      }
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
      const uptime = Math.floor(process.uptime());
      return `◆ 运行状态：正常\n◆ 内存占用：${mem} MB\n◆ 运行时间：${uptime} 秒`;
    }

    // ===== (#重启) 指令 =====
    if (text.includes('重启')) {
        if (role !== 'master' && role !== 'owner') {
            return '❌ 权限不足：仅主人可执行重启操作。';
        }

        const { sendMsg } = await import('../../xy-bot/adapter.js'); // 确保路径正确
        await sendMsg(chatId, '🔃 机器人正在重启，请稍候...', isGroup);

        try {
            const { spawn } = await import('child_process');
        
            // 1. 将当前 Node 进程的 PID 传给 Python，方便它等下“杀旧开新”
            // 判断当前系统，如果是 win32 就用 'python'，否则（Linux/Mac）用 'python3'
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            // 下面这行里的 'python' 替换成变量 pythonCmd
            const pyProcess = spawn(pythonCmd, ['script.py', process.pid.toString()], {
                detached: true,
                stdio: 'ignore'
            });
        
            pyProcess.unref();

            // 2. 延迟 2 秒后退出当前进程（把控制权交给 Python 去杀自己和开新窗口）
            setTimeout(() => {
                process.exit(0);
            }, 2000);

        } catch (e) {
            console.error('重启失败: ', e);
        }
    }

    // ─── [ #退出 ] 指令 ──────────────────────────────────
    if (text.includes('退出')) {
      if (role !== 'master' && role !== 'owner') {
        return '❌ 权限不足：仅主人可执行关闭操作。';
      }
      const { sendMsg } = await import('../../xy-bot/adapter.js');
      await sendMsg(chatId, '◆ 机器人已关闭。', isGroup);
      process.exit(0);
      return null;
    }

    return null;
  }
}
