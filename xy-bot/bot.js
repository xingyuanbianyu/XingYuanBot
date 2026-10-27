// xy-bot/bot.js
import repl from 'repl';

// ANSI 颜色转义码
const color = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

let isProcessing = false;

export function startBot() {
  // 使用 repl 模块，原生支持上下键历史记录和 Tab 补全
  const rl = repl.start({
    prompt: color.cyan('\nXingYuanBot > '),
    eval: (cmd, context, filename, callback) => {
      handleCommand(cmd.trim(), rl).then(() => callback(null, undefined));
    }
  });

  // 🌟 核心修复：防止后台日志打断用户的输入，同时兼容 pm2 等非 TTY 环境
  const originalPrint = globalThis.print || console.log;
  globalThis.print = (...args) => {
    if (process.stdout.isTTY && typeof process.stdout.clearLine === 'function') {
      // 在真实终端环境下：清除当前行 -> 打印日志 -> 重绘输入提示符
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      originalPrint(...args);
      rl.displayPrompt();
    } else {
      // 在 pm2、docker 或 重定向到文件 等非 TTY 环境下：直接打印，绝不清行
      originalPrint(...args);
    }
  };

  console.log(color.green('✅ Bot 核心已就绪'));
  console.log(color.gray('💡 输入 help 查看可用命令，按上下键可翻阅历史'));

  async function handleCommand(input, replInstance) {
    if (!input) return;
    
    if (isProcessing) {
      console.log(color.yellow('⏳ 上一条指令仍在处理中，请稍候...'));
      return;
    }

    const [cmd, ...args] = input.split(/\s+/);
    const command = cmd.toLowerCase();
    const arg1 = args[0]?.toLowerCase();

    // 退出逻辑特殊处理，不需要解锁
    if (command === 'quit' || command === 'exit') {
      console.log(color.yellow('👋 正在关闭 XingYuanBot，请稍候...'));
      replInstance.close();
      isProcessing = true; 
      process.emit('SIGINT'); 
      return;
    }

    isProcessing = true;

    try {
      switch (command) {
        case 'help':
          console.log(color.cyan('\n🛠 可用终端命令:'));
          console.log('  status      - 查看当前 Bot 连接状态与运行信息');
          console.log('  plugins     - 列出当前加载的所有插件');
          console.log('  reload      - 全量热重载所有插件 (插件开发必备)');
          console.log('  reload lib  - 热重载共享库并重载所有插件');
          console.log('  clear       - 清空终端屏幕');
          console.log('  quit/exit   - 关闭机器人并退出');
          break;

        case 'status': {
          console.log(color.cyan('\n📊 当前系统状态:'));
          
          const activeWs = globalThis.activeWs;
          const botIdToWs = globalThis.sharedState?.botIdToWs;
          
          if (activeWs && activeWs.readyState === 1) {
            console.log(color.green('  🟢 WebSocket: 已连接 (Active)'));
          } else {
            console.log(color.red('  🔴 WebSocket: 未连接或已断开'));
          }

          if (botIdToWs && botIdToWs.size > 0) {
            console.log(color.gray(`  🔗 绑定的 Bot 账号数: ${botIdToWs.size}`));
            for (const [id, ws] of botIdToWs.entries()) {
               console.log(color.gray(`     - Bot QQ: ${id} | 状态: ${ws.readyState === 1 ? '正常' : '异常'}`));
            }
          }

          const plugins = globalThis._plugins || [];
          console.log(color.gray(`  🔌 已加载插件数: ${plugins.length}`));
          break;
        }

        case 'plugins': {
          const plugins = globalThis._plugins || [];
          console.log(color.cyan(`\n🔌 当前已加载插件 (${plugins.length} 个):`));
          const categories = {};
          
          for (const p of plugins) {
            if (!p || !p.name) continue;
            const cat = p.category || '未分类';
            if (!categories[cat]) categories[cat] = [];
            
            const codeStr = p.code !== undefined ? color.yellow(`[代号:${p.code}]`) : '';
            categories[cat].push(`${p.name} ${codeStr}`);
          }

          if (Object.keys(categories).length === 0) {
             console.log(color.gray('  (暂无插件)'));
          }

          for (const [cat, names] of Object.entries(categories)) {
            console.log(`  📂 ${color.green(cat)}: ${names.join(', ')}`);
          }
          break;
        }

        case 'reload':
          if (arg1 === 'lib' || arg1 === 'libs') {
            if (typeof globalThis._xyReloadLibs === 'function') {
              console.log(color.yellow('🔄 正在热重载共享库和插件，请稍候...'));
              await globalThis._xyReloadLibs(true);
              console.log(color.green('✅ 共享库及插件重载完毕'));
            } else {
              console.log(color.red('⚠️ 全局未挂载 _xyReloadLibs 方法'));
            }
          } else {
            if (typeof globalThis._xyReloadPlugins === 'function') {
              console.log(color.yellow('🔄 正在全量热重载插件...'));
              await globalThis._xyReloadPlugins();
              console.log(color.green('✅ 插件全量重载完毕'));
            } else {
              console.log(color.red('⚠️ 全局未挂载 _xyReloadPlugins 方法'));
            }
          }
          break;

        case 'clear':
        case 'cls':
          // 🌟 加个小保护，防止在 pm2 下 console.clear 把日志清空导致什么都看不到
          if (process.stdout.isTTY) {
            console.clear();
          } else {
            console.log('当前处于后台运行环境，无法清屏。');
          }
          break;

        default:
          console.log(color.yellow(`⚠️ 未知命令: ${cmd}，输入 help 查看帮助`));
          break;
      }
    } catch (e) {
      console.log(color.red(`❌ 执行命令 [${cmd}] 时发生异常: ${e.message}`));
    } finally {
      // 解锁
      isProcessing = false;
    }
  }

  // 处理 Ctrl+C 直接退出
  rl.on('SIGINT', () => {
    console.log(color.yellow('\n👋 接收到 Ctrl+C，正在关闭...'));
    rl.close();
    isProcessing = true;
    process.emit('SIGINT');
  });
}