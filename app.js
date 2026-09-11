// app.js
import { startBot } from './xy-bot/bot.js';
import { connectOneBot } from './xy-bot/adapter.js';

async function main() {
  console.log('🚀 XingYuanBot 启动中...\n');

  // 监听 3001 端口，等待 NapCatQQ 来连
  const server = await connectOneBot(3001);

  // 启动终端交互
  startBot(server);
}

main();
