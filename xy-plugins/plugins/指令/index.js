import { generateHelpCard } from './card.js';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import os from 'os'; 
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { manageBlacklist } from '../../../xy-bot/blacklist.js';
import { hasPermission, getRole } from '../../../xy-config/config/permissions.js';
import { getConfig } from '../../../xy-bot/config.js'; 

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../'); 
const CONFIG_PATH = path.join(PROJECT_ROOT, 'xy-config/config.yaml');
const MENU_PATH = path.join(__dirname, 'menu.json');
const CACHE_DIR = path.join(PROJECT_ROOT, 'temp/cache');

let statusBrowser = null;

// ==================== 辅助函数 ====================
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

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function forceRefreshHelp(chatId, isGroup) {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    
    const fileName = isGroup ? `help_group_${chatId}` : 'help_private';
    let deletedCount = 0;
    
    for (const file of [`${fileName}.png`, `${fileName}.txt`]) {
        const filePath = path.join(CACHE_DIR, file);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); deletedCount++; } catch (e) {}
        }
    }

    try {
        if (fs.existsSync(MENU_PATH)) {
            const menu = JSON.parse(fs.readFileSync(MENU_PATH, 'utf-8'));
            if (menu.version !== undefined) {
                menu.version += 1;
                fs.writeFileSync(MENU_PATH, JSON.stringify(menu, null, 4), 'utf-8');
            }
        }
    } catch (e) {}
    return deletedCount;
}

function updateYamlConfig(mutatorFn) {
    try {
        const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
        const resultMsg = mutatorFn(config);
        
        // 如果返回了成功标识，才写入文件
        if (resultMsg && !resultMsg.startsWith('❌') && !resultMsg.startsWith('⚠️')) {
            const tmpPath = CONFIG_PATH + '.tmp';
            fs.writeFileSync(tmpPath, yaml.stringify(config), 'utf8');
            fs.renameSync(tmpPath, CONFIG_PATH); // 原子写入
            
            if (typeof globalThis._configReload === 'function') globalThis._configReload();
        }
        return resultMsg;
    } catch (e) {
        return `❌ 操作配置文件失败: ${e.message}`;
    }
}

// ==================== 完整的监控面板 HTML ====================
const getStatusHtml = (data) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #1e1e24, #2b2b36); color: #fff; width: 540px; padding: 24px; }
        .card { background: rgba(255, 255, 255, 0.03); border-radius: 20px; padding: 24px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); backdrop-filter: blur(10px); }
        .header { display: flex; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 16px; }
        .header h2 { margin: 0; font-size: 22px; color: #fff; display: flex; align-items: center; gap: 8px; }
        .header .dot { width: 12px; height: 12px; background: #4CAF50; border-radius: 50%; box-shadow: 0 0 10px #4CAF50; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .item { background: rgba(0, 0, 0, 0.2); padding: 16px; border-radius: 12px; }
        .label { font-size: 13px; color: #999; margin-bottom: 6px; }
        .value { font-size: 16px; font-weight: 600; word-break: break-all; line-height: 1.4; }
        .full-width { grid-column: 1 / -1; }
        .progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; margin-top: 10px; overflow: hidden; }
        .progress-fill { height: 100%; border-radius: 3px; }
        .text-green { color: #4CAF50; } .text-blue { color: #2196F3; } .text-orange { color: #FF9800; }
        .bg-green { background: linear-gradient(90deg, #4CAF50, #8BC34A); }
        .bg-orange { background: linear-gradient(90deg, #FF9800, #FFC107); }
    </style>
</head>
<body>
    <div class="card">
        <div class="header"><h2><div class="dot"></div> 运行状态监控</h2></div>
        <div class="grid">
            <div class="item"><div class="label">运行时间</div><div class="value text-blue">${data.uptime}</div></div>
            <div class="item"><div class="label">Node 版本</div><div class="value">${data.nodeVersion}</div></div>
            <div class="item full-width"><div class="label">系统平台</div><div class="value">${data.osInfo}</div></div>
            <div class="item full-width"><div class="label">处理器 (CPU)</div><div class="value">${data.cpuInfo}</div></div>
            <div class="item full-width"><div class="label">系统负载 (1m, 5m, 15m)</div><div class="value">${data.loadAvg}</div></div>
            <div class="item full-width">
                <div class="label">系统内存 (已用 ${data.usedMem} / 共 ${data.totalMem})</div>
                <div class="value text-green">${data.memPercent}%</div>
                <div class="progress-bar"><div class="progress-fill bg-green" style="width: ${data.memPercent}%;"></div></div>
            </div>
            <div class="item full-width">
                <div class="label">进程内存 (RSS ${data.rss} / 堆 ${data.heapUsed})</div>
                <div class="value text-orange">${data.heapPercent}%</div>
                <div class="progress-bar"><div class="progress-fill bg-orange" style="width: ${data.heapPercent}%;"></div></div>
            </div>
        </div>
    </div>
</body>
</html>
`;

export default {
  name: '指令',

  match: (text) => {
    if (typeof text !== 'string') return false;
    const pureText = text.trim();
    if (!pureText) return false;

    const keywords = [
        '帮助', '菜单', '状态', '退出', '权限', '重启', '重载', '重新生成', '刷新菜单',
        '查询黑名单', '查询白名单', '启用前缀', '禁用前缀', '查询前缀',
        '启用指令白名单', '禁用指令白名单', '查询指令白名单'
    ];
    
    if (keywords.includes(pureText)) return true;
    if (/^(拉黑|取消)\s*\d{5,13}\s+[01]$/.test(pureText)) return true;
    if (/^(添加|删除)(前缀|指令白名单)/.test(pureText)) return true;

    return false;
  },

  handle: async (msgObj) => {
        const pureText = (msgObj.pureText || "").trim();
        const senderId = String(msgObj.senderQQ || msgObj.user_id || msgObj.senderId || '');
        const senderName = msgObj.senderName || '未知';
        const chatId = msgObj.chatId || msgObj.group_id || msgObj.user_id; 
        const isGroup = msgObj.isGroup || msgObj.message_type === 'group'; 
        
        // 🌟 核心修复：获取当前接收消息的 Bot ID，用于判断局部权限
        const botId = msgObj.botId || msgObj.selfId || msgObj.rawData?.self_id;
        
        if (!senderId || senderId === 'undefined') return null;

        // 🌟 核心修复：传入 botId，让局部大主人/小主人生效！
        const isMaster = hasPermission(senderId, 'master', botId);
        const isOwner = isMaster || hasPermission(senderId, 'owner', botId);

        // ==========================================
        // 1. 帮助 / 菜单
        // ==========================================
        if (pureText === '帮助' || pureText === '菜单') {
          try {
            const imagePath = await generateHelpCard(chatId, isGroup);
            if (!imagePath) return '❌ 生成帮助图片失败。';
            const buffer = fs.readFileSync(imagePath);
            return { file: buffer };
          } catch (e) {
            console.error('生成帮助卡片失败:', e);
            return `❌ 获取帮助失败: ${e.message}`;
          }
        }

        // ==========================================
        // 2. 重新生成
        // ==========================================
        if (pureText === '重新生成' || pureText === '刷新菜单') {
            if (!isOwner) return '❌ 权限不足：仅主人可执行此操作。';
            try {
                const deletedCount = forceRefreshHelp(chatId, isGroup); 
                const imagePath = await generateHelpCard(chatId, isGroup);
                if (!imagePath) throw new Error('生成函数返回为空');
                const buffer = fs.readFileSync(imagePath);
                return { file: buffer, content: `✅ 已清理 ${deletedCount} 个缓存，重新生成完毕！` };
            } catch (e) {
                return `❌ 重新生成失败: ${e.message}`;
            }
        }

        // ==========================================
        // 3. 权限查询 (之前漏掉的)
        // ==========================================
        if (pureText === '权限') {
            const roleMap = {
                master: '👑 大主人（最高权限）',
                owner:  '🌟 小主人（主人权限）',
                admin:  '🛡 管理员',
                member: '👤 普通成员'
            };
            const userRole = getRole(senderId, botId);
            return `【${senderName}】的权限等级：${roleMap[userRole] || '未知'}`;
        }

        // ==========================================
        // 4. 全局黑白名单拉黑操作 (之前漏掉的)
        // ==========================================
        if (/^(拉黑|取消)\s*\d{5,13}\s+[01]$/.test(pureText)) {
            if (!isOwner) return '❌ 权限不足：仅主人可管理黑名单。';

            const match = pureText.match(/^(拉黑|取消)\s*(\d{5,13})\s+([01])$/);
            const target = match[2];
            const flag = match[3];
            const type = flag === '1' ? 'group' : 'qq';
            const isAdd = match[1] === '拉黑';

            try {
                const result = manageBlacklist(type, target, isAdd);
                return result;
            } catch (e) {
                return `❌ 操作黑名单失败: ${e.message}`;
            }
        }

        // ==========================================
        // 5. 全局黑白名单查询
        // ==========================================
        if (pureText === '查询黑名单' || pureText === '查询白名单') {
            if (!isMaster) return '❌ 权限不足：仅大主人可查看全局黑白名单。';
            const cfg = getConfig();
            const type = pureText === '查询黑名单' ? 'blacklist' : 'whitelist';
            const icon = type === 'blacklist' ? '🛑' : '🛡️';
            const name = type === 'blacklist' ? '黑名单' : '白名单';
            
            const qqList = cfg[`${type}_qq`]?.length > 0 ? cfg[`${type}_qq`].join('\n') : '空';
            const groupList = cfg[`${type}_group`]?.length > 0 ? cfg[`${type}_group`].join('\n') : '空';
            
            return `${icon} 全局${name}配置：\n\n👤 ${name}用户：\n${qqList}\n\n👥 ${name}群聊：\n${groupList}`;
        }

        // ==========================================
        // 6. 前缀管理
        // ==========================================
        if (/^(启用|禁用|查询)前缀$/.test(pureText) || pureText.startsWith('添加前缀') || pureText.startsWith('删除前缀')) {
            if (!isMaster) return '❌ 权限不足：仅大主人可管理前缀。';
            
            return updateYamlConfig((config) => {
                if (!config.command_prefix) config.command_prefix = { enable: true, prefixes: ['#', '/'] };
                const cp = config.command_prefix;

                if (pureText === '查询前缀') {
                    return `⚙️ 当前前缀配置：\n状态：${cp.enable ? '✅ 启用' : '❌ 禁用'}\n前缀列表：${cp.prefixes?.join(' , ') || '空'}`;
                }
                if (pureText === '启用前缀') { cp.enable = true; return '✅ 已启用指令前缀。'; }
                if (pureText === '禁用前缀') { cp.enable = false; return '✅ 已禁用指令前缀。'; }

                if (pureText.startsWith('添加前缀')) {
                    const newPrefix = pureText.replace('添加前缀', '').trim();
                    if (!newPrefix) return '⚠️ 用法：添加前缀 !';
                    if (newPrefix.length > 3) return '❌ 前缀过长：最多 3 个字符。';
                    if (!cp.prefixes) cp.prefixes = [];
                    if (cp.prefixes.includes(newPrefix)) return '⚠️ 该前缀已经存在了。';
                    cp.prefixes.push(newPrefix);
                    return `✅ 已添加前缀 [${newPrefix}]，当前：${cp.prefixes.join(' , ')}`;
                }

                if (pureText.startsWith('删除前缀')) {
                    const delPrefix = pureText.replace('删除前缀', '').trim();
                    if (!delPrefix) return '⚠️ 用法：删除前缀 !';
                    if (!cp.prefixes || !cp.prefixes.includes(delPrefix)) return '⚠️ 该前缀不存在。';
                    cp.prefixes = cp.prefixes.filter(p => p !== delPrefix);
                    return `✅ 已删除前缀 [${delPrefix}]，当前：${cp.prefixes.join(' , ') || '空'}`;
                }
            });
        }

        // ==========================================
        // 7. 指令白名单管理 (之前完全漏掉的)
        // ==========================================
        if (pureText === '启用指令白名单' || pureText === '禁用指令白名单' || pureText === '查询指令白名单' || pureText.startsWith('添加指令白名单') || pureText.startsWith('删除指令白名单')) {
            if (!isMaster) return '❌ 权限不足：仅大主人可管理指令白名单。';

            return updateYamlConfig((config) => {
                if (!config.whitelist) config.whitelist = { enable: false, list: [] };
                const wl = config.whitelist;

                if (pureText === '查询指令白名单') {
                    return `🛡️ 当前免前缀指令白名单：\n状态：${wl.enable ? '✅ 启用' : '❌ 禁用'}\n特权指令：${wl.list?.join(' , ') || '空'}`;
                }
                if (pureText === '启用指令白名单') { wl.enable = true; return '✅ 已启用指令白名单。'; }
                if (pureText === '禁用指令白名单') { wl.enable = false; return '✅ 已禁用指令白名单。'; }

                if (pureText.startsWith('添加指令白名单')) {
                    const newCmd = pureText.replace('添加指令白名单', '').trim();
                    if (!newCmd) return '⚠️ 用法：添加指令白名单 帮助';
                    if (!wl.list) wl.list = [];
                    if (wl.list.includes(newCmd)) return '⚠️ 该指令已经在白名单中了。';
                    wl.list.push(newCmd);
                    return `✅ 已将 [${newCmd}] 加入白名单。`;
                }

                if (pureText.startsWith('删除指令白名单')) {
                    const delCmd = pureText.replace('删除指令白名单', '').trim();
                    if (!delCmd) return '⚠️ 用法：删除指令白名单 帮助';
                    if (!wl.list || !wl.list.includes(delCmd)) return '⚠️ 该指令不在白名单中。';
                    wl.list = wl.list.filter(c => c !== delCmd);
                    return `✅ 已将 [${delCmd}] 移出白名单。`;
                }
            });
        }

        // ==========================================
        // 8. 状态 (带完整 HTML 面板)
        // ==========================================
        if (pureText === '状态') {
          if (!isOwner && !hasPermission(senderId, 'admin', botId)) return '❌ 权限不足。';
          
          const mem = process.memoryUsage();
          const totalMem = os.totalmem();
          const usedMem = totalMem - os.freemem();
          const cpus = os.cpus();
          
          const data = {
              uptime: formatUptime(process.uptime()),
              nodeVersion: process.version,
              osInfo: `${os.type()} ${os.release()} (${os.arch()})`,
              cpuInfo: `${cpus.length} 核 | ${cpus.length > 0 ? cpus[0].model.trim() : '未知'}`,
              loadAvg: os.loadavg().map(v => v.toFixed(2)).join(' &nbsp;&nbsp;|&nbsp;&nbsp; '),
              usedMem: formatBytes(usedMem),
              totalMem: formatBytes(totalMem),
              memPercent: ((usedMem / totalMem) * 100).toFixed(1),
              rss: formatBytes(mem.rss),
              heapUsed: formatBytes(mem.heapUsed),
              heapPercent: ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1)
          };

          let page = null;
          let context = null;
          try {
              if (!statusBrowser || !statusBrowser.isConnected()) {
                  statusBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
              }
              context = await statusBrowser.newContext({ viewport: { width: 540, height: 580 }, deviceScaleFactor: 2 });
              page = await context.newPage();
              await page.setContent(getStatusHtml(data), { waitUntil: 'networkidle' });
              const buffer = await page.screenshot({ type: 'png', omitBackground: true });
              return { file: buffer };
          } catch (e) {
              console.error('状态图片渲染失败:', e);
              return `🟢 运行状态：正常\n⏱️ 运行时间：${data.uptime}\n🧠 系统内存：${data.usedMem} / ${data.totalMem} (${data.memPercent}%)`;
          } finally {
              if (context) await context.close().catch(()=>{});
          }
        }

        // ==========================================
        // 9. 重启
        // ==========================================
        if (pureText === '重启') {
          if (!isOwner) return '❌ 权限不足。';
          setTimeout(async () => {
            const { spawn } = await import('child_process');
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            const scriptPath = path.join(PROJECT_ROOT, 'restart.py'); 
            
            const pyProcess = spawn(pythonCmd, [scriptPath, process.pid.toString()], {
              detached: true,
              stdio: 'ignore',
              cwd: PROJECT_ROOT 
            });
            pyProcess.unref();
            setTimeout(() => { process.exit(0); }, 1500);
          }, 500);
          return '🔷 Bot 正在重启，请稍候...';
        }

        // ==========================================
        // 10. 重载
        // ==========================================
        if (pureText === '重载') {
          if (!isOwner) return '❌ 权限不足。';
          try {
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
        // 11. 退出
        // ==========================================
        if (pureText === '退出') {
          if (!isOwner) return '❌ 权限不足。';
          setTimeout(() => { process.exit(0); }, 1000);
          return '🔷 Bot已退出。';
        }

        return null;
  }
};