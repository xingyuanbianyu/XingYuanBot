import { generateHelpCard } from './card.js';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import os from 'os'; 
import { fileURLToPath } from 'url';
import { chromium } from 'playwright'; // 🌟 引入 Playwright 用于渲染图片
import { manageBlacklist } from '../../../xy-bot/blacklist.js';
import { hasPermission, getRole } from '../../../xy-config/config/permissions.js';
import { getConfig } from '../../../xy-bot/config.js'; 

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../../xy-config/config.yaml');

// 🌟 全局浏览器实例（避免每次查状态都重启浏览器）
let statusBrowser = null;

// 🌟 辅助函数：格式化运行时间
function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    let str = '';
    if (d > 0) str += `${d}天 `;
    if (h > 0) str += `${h}小时 `;
    if (m > 0) str += `${m}分 `;
    str += `${s}秒`;
    return str;
}

// 🌟 辅助函数：格式化内存大小
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export default {
  name: '指令',

  match: (text) => {
    if (typeof text !== 'string') return false;
    const pureText = text.trim();
    if (!pureText) return false;

    const isBlacklistCmd = pureText.startsWith('拉黑') || pureText.startsWith('取消');
    
    const isPrefixCmd = pureText === '启用前缀' || pureText === '禁用前缀' ||
                        pureText === '查询前缀' || pureText.startsWith('添加前缀') ||
                        pureText.startsWith('删除前缀');

    const isWhitelistCmd = pureText === '启用指令白名单' || pureText === '禁用指令白名单' ||
                           pureText === '查询指令白名单' || pureText.startsWith('添加指令白名单') ||
                           pureText.startsWith('删除指令白名单');

    const isGlobalListCmd = pureText === '查询黑名单' || pureText === '查询白名单';

    return pureText === '帮助' ||
        pureText === '状态' ||
        pureText === '退出' ||
        pureText === '权限' ||
        pureText === '重启' ||
        pureText === '重载' ||
        pureText === '菜单' ||
        isBlacklistCmd ||
        isPrefixCmd ||
        isWhitelistCmd ||
        isGlobalListCmd;
  },

  handle: async (msgObj) => {
        const pureText = (msgObj.pureText || "").trim();
        const senderId = String(msgObj.senderQQ || msgObj.user_id || msgObj.senderId || '');
        const senderName = msgObj.senderName || '未知';
        const chatId = msgObj.chatId || msgObj.group_id || msgObj.user_id; 
        
        if (!senderId || senderId === 'undefined') return null;

        const isMaster = hasPermission(senderId, 'master');

        // ==========================================
        // 🌟 全局黑/白名单查询
        // ==========================================
        if (pureText === '查询黑名单' || pureText === '查询白名单') {
            if (!isMaster) return '❌ 权限不足：仅大主人可查看全局黑白名单。';
            
            const cfg = getConfig();
            
            if (pureText === '查询黑名单') {
                const qqList = cfg.blacklist_qq.length > 0 ? cfg.blacklist_qq.join('\n') : '空';
                const groupList = cfg.blacklist_group.length > 0 ? cfg.blacklist_group.join('\n') : '空';
                return `🛑 全局黑名单配置：\n\n👤 黑名单用户：\n${qqList}\n\n👥 黑名单群聊：\n${groupList}`;
            }
            
            if (pureText === '查询白名单') {
                const qqList = cfg.whitelist_qq.length > 0 ? cfg.whitelist_qq.join('\n') : '空';
                const groupList = cfg.whitelist_group.length > 0 ? cfg.whitelist_group.join('\n') : '空';
                return `🛡️ 全局白名单配置：\n\n👤 白名单用户：\n${qqList}\n\n👥 白名单群聊：\n${groupList}`;
            }
        }

        // ==========================================
        // 🌟 前缀管理指令
        // ==========================================
        if (pureText === '启用前缀' || pureText === '禁用前缀' || pureText === '查询前缀' || pureText.startsWith('添加前缀') || pureText.startsWith('删除前缀')) {
            if (!isMaster) return '❌ 权限不足：仅大主人可管理前缀。';

            try {
                const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
                if (!config.command_prefix) {
                    config.command_prefix = { enable: true, prefixes: ['#', '/'] };
                }
                const cp = config.command_prefix;

                if (pureText === '查询前缀') {
                    return `⚙️ 当前前缀配置：\n状态：${cp.enable ? '✅ 启用' : '❌ 禁用'}\n前缀列表：${cp.prefixes && cp.prefixes.length > 0 ? cp.prefixes.join(' , ') : '空（无前缀直接触发）'}`;
                }

                if (pureText === '启用前缀') {
                    cp.enable = true;
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return '✅ 已启用指令前缀，热更新生效中。';
                }

                if (pureText === '禁用前缀') {
                    cp.enable = false;
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return '✅ 已禁用指令前缀，现在发送指令无需带任何符号。';
                }

                if (pureText.startsWith('添加前缀')) {
                    const newPrefix = pureText.replace('添加前缀', '').trim();
                    if (!newPrefix) return '⚠️ 用法：添加前缀 ! （请附带你要添加的符号）';
                    if (newPrefix.length > 3) return '❌ 前缀过长：最多 3 个字符。';
                    
                    if (!cp.prefixes) cp.prefixes = [];
                    if (cp.prefixes.includes(newPrefix)) return '⚠️ 该前缀已经存在了。';
                    
                    cp.prefixes.push(newPrefix);
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return `✅ 已成功添加前缀 [${newPrefix}]，当前前缀列表：${cp.prefixes.join(' , ')}`;
                }

                if (pureText.startsWith('删除前缀')) {
                    const delPrefix = pureText.replace('删除前缀', '').trim();
                    if (!delPrefix) return '⚠️ 用法：删除前缀 ! （请附带你要删除的符号）';
                    
                    if (!cp.prefixes || !cp.prefixes.includes(delPrefix)) return '⚠️ 该前缀不存在。';
                    
                    cp.prefixes = cp.prefixes.filter(p => p !== delPrefix);
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return `✅ 已成功删除前缀 [${delPrefix}]，当前前缀列表：${cp.prefixes.length > 0 ? cp.prefixes.join(' , ') : '空'}`;
                }
            } catch (e) {
                return `❌ 操作配置文件失败：${e.message}`;
            }
        }

        // ==========================================
        // 🌟 指令白名单管理
        // ==========================================
        if (pureText === '启用指令白名单' || pureText === '禁用指令白名单' || pureText === '查询指令白名单' || pureText.startsWith('添加指令白名单') || pureText.startsWith('删除指令白名单')) {
            if (!isMaster) return '❌ 权限不足：仅大主人可管理白名单。';

            try {
                const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
                if (!config.whitelist) {
                    config.whitelist = { enable: false, list: [] };
                }
                const wl = config.whitelist;

                if (pureText === '查询指令白名单') {
                    return `🛡️ 当前免前缀指令白名单：\n状态：${wl.enable ? '✅ 启用' : '❌ 禁用'}\n特权指令：${wl.list && wl.list.length > 0 ? wl.list.join(' , ') : '空'}`;
                }

                if (pureText === '启用指令白名单') {
                    wl.enable = true;
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return '✅ 已启用指令白名单（白名单内的指令无需前缀即可触发）。';
                }

                if (pureText === '禁用指令白名单') {
                    wl.enable = false;
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return '✅ 已禁用指令白名单。';
                }

                if (pureText.startsWith('添加指令白名单')) {
                    const newCmd = pureText.replace('添加指令白名单', '').trim();
                    if (!newCmd) return '⚠️ 用法：添加指令白名单 帮助';
                    
                    if (!wl.list) wl.list = [];
                    if (wl.list.includes(newCmd)) return '⚠️ 该指令已经在白名单中了。';
                    
                    wl.list.push(newCmd);
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return `✅ 已成功将 [${newCmd}] 加入白名单，当前包含：${wl.list.join(' , ')}`;
                }

                if (pureText.startsWith('删除指令白名单')) {
                    const delCmd = pureText.replace('删除指令白名单', '').trim();
                    if (!delCmd) return '⚠️ 用法：删除指令白名单 帮助';
                    
                    if (!wl.list || !wl.list.includes(delCmd)) return '⚠️ 该指令不在白名单中。';
                    
                    wl.list = wl.list.filter(c => c !== delCmd);
                    fs.writeFileSync(CONFIG_PATH, yaml.stringify(config), 'utf8');
                    return `✅ 已成功将 [${delCmd}] 从白名单移除，当前包含：${wl.list.length > 0 ? wl.list.join(' , ') : '空'}`;
                }
            } catch (e) {
                return `❌ 操作配置文件失败：${e.message}`;
            }
        }

        // ==========================================
        // [ 拉黑 / 取消 ] 指令
        // ==========================================
        if (pureText.startsWith('拉黑') || pureText.startsWith('取消')) {
          if (!hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
            return '❌ 权限不足：仅主人可管理黑名单。';
          }

          const match = pureText.match(/^(拉黑|取消)\s*(\d{5,13})\s+([01])$/);

          if (!match) {
            const looseMatch = pureText.match(/^(?:拉黑|取消)\s*(\d{5,13})\s+(.+)$/);
            if (looseMatch && looseMatch[2] !== '0' && looseMatch[2] !== '1') {
              return `❌ 末尾参数错误：'${looseMatch[2]}'，只允许 0（用户）或 1（群）。`;
            }
            return '❌ 格式错误，例如：拉黑 123456 0（拉黑用户）或 拉黑 123456 1（拉黑群）';
          }

          const target = match[2];
          const flag = match[3];
          const type = flag === '1' ? 'group' : 'qq';
          const isAdd = match[1] === '拉黑';

          return manageBlacklist(type, target, isAdd);
        }

        // ==========================================
        // [ 权限 ] 指令
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
        // [ 帮助 ] 指令
        // ==========================================
        if (pureText === '帮助' || pureText === '菜单') {
          try {
            const imagePath = await generateHelpCard(chatId);
            const buffer = fs.readFileSync(imagePath);
            return { file: buffer };
          } catch (e) {
            console.error('生成帮助卡片失败:', e);
            return '❌ 获取帮助失败';
          }
        }

        // ==========================================
        // 🌟 [ 状态 ] 指令 —— 图片渲染版
        // ==========================================
        if (pureText === '状态') {
          if (!hasPermission(senderId, 'admin') && !hasPermission(senderId, 'master') && !hasPermission(senderId, 'owner')) {
            return '❌ 权限不足：该指令仅限管理员及以上身份使用。';
          }
          
          const mem = process.memoryUsage();
          const totalMem = os.totalmem();
          const freeMem = os.freemem();
          const usedMem = totalMem - freeMem;
          const cpus = os.cpus();
          const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : '未知';
          const loadAvg = os.loadavg();

          const uptime = formatUptime(process.uptime());
          const memPercent = ((usedMem / totalMem) * 100).toFixed(1);
          const heapPercent = ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1);

          const html = `
          <!DOCTYPE html>
          <html>
          <head>
              <meta charset="utf-8">
              <style>
                  * { box-sizing: border-box; margin: 0; padding: 0; }
                  body {
                      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                      background: linear-gradient(135deg, #1e1e24, #2b2b36);
                      color: #fff;
                      width: 540px;
                      padding: 24px;
                  }
                  .card {
                      background: rgba(255, 255, 255, 0.03);
                      border-radius: 20px;
                      padding: 24px;
                      border: 1px solid rgba(255, 255, 255, 0.08);
                      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
                      backdrop-filter: blur(10px);
                  }
                  .header {
                      display: flex;
                      align-items: center;
                      margin-bottom: 20px;
                      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                      padding-bottom: 16px;
                  }
                  .header h2 { margin: 0; font-size: 22px; color: #fff; display: flex; align-items: center; gap: 8px;}
                  .header .dot { width: 12px; height: 12px; background: #4CAF50; border-radius: 50%; box-shadow: 0 0 10px #4CAF50; }
                  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
                  .item { background: rgba(0, 0, 0, 0.2); padding: 16px; border-radius: 12px; }
                  .label { font-size: 13px; color: #999; margin-bottom: 6px; }
                  .value { font-size: 16px; font-weight: 600; word-break: break-all; line-height: 1.4; }
                  .full-width { grid-column: 1 / -1; }
                  .progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; margin-top: 10px; overflow: hidden; }
                  .progress-fill { height: 100%; border-radius: 3px; }
                  .text-green { color: #4CAF50; }
                  .text-blue { color: #2196F3; }
                  .text-orange { color: #FF9800; }
                  .bg-green { background: linear-gradient(90deg, #4CAF50, #8BC34A); }
                  .bg-orange { background: linear-gradient(90deg, #FF9800, #FFC107); }
              </style>
          </head>
          <body>
              <div class="card">
                  <div class="header">
                      <h2><div class="dot"></div> 运行状态监控</h2>
                  </div>
                  <div class="grid">
                      <div class="item">
                          <div class="label">运行时间</div>
                          <div class="value text-blue">${uptime}</div>
                      </div>
                      <div class="item">
                          <div class="label">Node 版本</div>
                          <div class="value">${process.version}</div>
                      </div>
                      <div class="item full-width">
                          <div class="label">系统平台</div>
                          <div class="value">${os.type()} ${os.release()} (${os.arch()})</div>
                      </div>
                      <div class="item full-width">
                          <div class="label">处理器 (CPU)</div>
                          <div class="value">${cpus.length} 核 | ${cpuModel}</div>
                      </div>
                      <div class="item full-width">
                          <div class="label">系统负载 (1m, 5m, 15m)</div>
                          <div class="value">${loadAvg.map(v => v.toFixed(2)).join(' &nbsp;&nbsp;|&nbsp;&nbsp; ')}</div>
                      </div>
                      
                      <div class="item full-width">
                          <div class="label">系统内存 (已用 ${formatBytes(usedMem)} / 共 ${formatBytes(totalMem)})</div>
                          <div class="value text-green">${memPercent}%</div>
                          <div class="progress-bar">
                              <div class="progress-fill bg-green" style="width: ${memPercent}%;"></div>
                          </div>
                      </div>
                      
                      <div class="item full-width">
                          <div class="label">进程内存 (RSS ${formatBytes(mem.rss)} / 堆 ${formatBytes(mem.heapUsed)})</div>
                          <div class="value text-orange">${heapPercent}%</div>
                          <div class="progress-bar">
                              <div class="progress-fill bg-orange" style="width: ${heapPercent}%;"></div>
                          </div>
                      </div>
                  </div>
              </div>
          </body>
          </html>
          `;

          try {
              // 复用浏览器实例
              if (!statusBrowser || !statusBrowser.isConnected()) {
                  statusBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
              }
              const context = await statusBrowser.newContext({
                  viewport: { width: 540, height: 580 },
                  deviceScaleFactor: 2 // 2倍分辨率，文字更清晰
              });
              const page = await context.newPage();
              await page.setContent(html, { waitUntil: 'networkidle' });
              const buffer = await page.screenshot({ type: 'png', omitBackground: true });
              await context.close(); // 只关页面上下文，不关浏览器
              
              return { file: buffer };
          } catch (e) {
              console.error('状态图片渲染失败，降级为文本:', e);
              // 渲染失败时，回退到纯文本
              const lines = [
                  `🟢 运行状态：正常运行`,
                  `⏱️ 运行时间：${uptime}`,
                  `📦 Node 版本：${process.version}`,
                  `💻 系统平台：${os.type()} ${os.release()} (${os.arch()})`,
                  `🖥️ 处理器 (CPU)：${cpus.length} 核 | ${cpuModel}`,
                  `📊 系统负载：${loadAvg.map(v => v.toFixed(2)).join(', ')}`,
                  `🧠 系统内存：${formatBytes(usedMem)} / ${formatBytes(totalMem)} (占用 ${memPercent}%)`,
                  `🚀 进程内存：${formatBytes(mem.rss)} (堆内存: ${formatBytes(mem.heapUsed)})`
              ];
              return lines.join('\n');
          }
        }

        // ==========================================
        // [ 重启 ] 指令
        // ==========================================
        if (pureText === '重启') {
          if (!isMaster && !hasPermission(senderId, 'owner')) {
            return '❌ 权限不足：仅主人可执行重启操作。';
          }
          setTimeout(async () => {
            const { spawn } = await import('child_process');
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            const pyProcess = spawn(pythonCmd, ['script.py', process.pid.toString()], {
              detached: true,
              stdio: 'ignore'
            });
            pyProcess.unref();
            setTimeout(() => { process.exit(0); }, 2000);
          }, 1000);
          return '🔷 Bot 正在重启，请稍候...';
        }

        // ==========================================
        // [ 重载 ] 指令
        // ==========================================
        if (pureText === '重载') {
          if (!isMaster && !hasPermission(senderId, 'owner')) {
            return '❌ 权限不足：仅主人可执行重载操作。';
          }
          try {
            const loaderURL = new URL('../../xy-bot/plugin-loader.js', import.meta.url).href;
            const { loadPlugins } = await import(loaderURL);
            if (typeof globalThis._xyReloadPlugins === 'function') {
              const reloaded = await globalThis._xyReloadPlugins();
              return `✅ 已重新加载 ${reloaded.length} 个插件！`;
            } else {
              return '❌ 重载入口未配置。';
            }
          } catch (e) {
            return '❌ 重载失败：' + e.message;
          }
        }

        // ==========================================
        // [ 退出 ] 指令
        // ==========================================
        if (pureText === '退出') {
          if (!isMaster && !hasPermission(senderId, 'owner')) {
            return '❌ 权限不足：仅主人可执行关闭操作。';
          }
          setTimeout(() => { process.exit(0); }, 1500);
          return '🔷 Bot已退出。';
        }

        return null;
  }
};