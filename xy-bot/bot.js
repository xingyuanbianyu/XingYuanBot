// xy-lib/bot.js
import readline from 'readline';

export function startBot(client) {
  // 创建终端读取接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nXingYuanBot > ',
  });

  console.log('✅ Bot 核心已就绪');
  console.log('💡 输入 help 查看可用命令');
  rl.prompt();

  // 监听你在终端输入的内容
  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const [cmd, ...args] = input.split(/\s+/);

    // 简单的终端指令路由
    switch (cmd.toLowerCase()) {
      case 'help':
        console.log('🛠 可用命令:');
        console.log('  status  - 查看 Bot 连接状态');
        console.log('  quit    - 关闭机器人并退出');
        break;

      case 'status':
        if (client && client.readyState === 1) {
          console.log('🟢 状态: 已连接到 NapCatQQ');
        } else {
          console.log('🔴 状态: 未连接或连接已断开');
        }
        break;

      case 'quit':
        console.log('👋 正在关闭 XingYuanBot...');
        if (client) client.close();
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`⚠️ 未知命令: ${cmd}，输入 help 查看帮助`);
        break;
    }

    rl.prompt();
  });
}
