// xy-bot/bot.js
import readline from 'readline';

// ANSI 颜色转义码，让终端更好看
const color = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

export function startBot() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: color.cyan('\nXingYuanBot > '),
  });

  console.log(color.green('✅ Bot 核心已就绪'));
  console.log(color.gray('💡 输入 help 查看可用命令'));
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) return rl.prompt();

    const [cmd, ...args] = input.split(/\s+/);
    const command = cmd.toLowerCase();
    const arg1 = args[0]?.toLowerCase();

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
          
          // 通过全局变量获取状态，不再依赖单一的 client 参数
          const activeWs = globalThis.activeWs;
          const wsPool = globalThis.sharedState?.wsPool;
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
            if (!categories[p.category]) categories[p.category] = [];
            const codeStr = p.code !== undefined ? color.yellow(`[代号:${p.code}]`) : '';
            categories[p.category].push(`${p.name} ${codeStr}`);
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
              await globalThis._xyReloadPlugins(); // 传空参数默认全量重载
              console.log(color.green('✅ 插件全量重载完毕'));
            } else {
              console.log(color.red('⚠️ 全局未挂载 _xyReloadPlugins 方法'));
            }
          }
          break;

        case 'clear':
        case 'cls':
          console.clear();
          break;

        case 'quit':
        case 'exit':
          console.log(color.yellow('👋 正在关闭 XingYuanBot...'));
          rl.close();
          // 优先触发优雅退出信号，让 main.js 里的 cleanupAllInstances 执行
          process.kill(process.pid, 'SIGINT'); 
          break;

        default:
          console.log(color.yellow(`⚠️ 未知命令: ${cmd}，输入 help 查看帮助`));
          break;
      }
    } catch (e) {
      console.log(color.red(`❌ 执行命令 [${cmd}] 时发生异常: ${e.message}`));
    }

    rl.prompt();
  });
}