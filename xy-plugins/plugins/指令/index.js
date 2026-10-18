import { generateHelpCard } from './card.js';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import { manageBlacklist } from '../../../xy-bot/blacklist.js';
import { hasPermission, getRole } from '../../../xy-config/config/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../../xy-config/config.yaml');

export default {
  name: '指令',

  match: (text) => {
    if (typeof text !== 'string') return false;
    const pureText = text.trim();
    if (!pureText) return false;

    const isBlacklistCmd = pureText.startsWith('拉黑') || pureText.startsWith('取消');
    
    // 🌟 前缀管理指令
    const isPrefixCmd = pureText === '启用前缀' || pureText === '禁用前缀' ||
                        pureText === '查询前缀' || pureText.startsWith('添加前缀') ||
                        pureText.startsWith('删除前缀');

    // 🌟 白名单管理指令
    const isWhitelistCmd = pureText === '启用指令白名单' || pureText === '禁用指令白名单' ||
                           pureText === '查询指令白名单' || pureText.startsWith('添加指令白名单') ||
                           pureText.startsWith('删除指令白名单');

    return pureText === '帮助' ||
        pureText === '状态' ||
        pureText === '退出' ||
        pureText === '权限' ||
        pureText === '重启' ||
        pureText === '重载' ||
        isBlacklistCmd ||
        isPrefixCmd ||
        isWhitelistCmd;
  },

  handle: async (msgObj) => {
        const pureText = (msgObj.pureText || "").trim();
        const senderId = String(msgObj.senderQQ || msgObj.user_id || msgObj.senderId || '');
        const senderName = msgObj.senderName || '未知';
        // 🌟 核心修复：补上 chatId 的提取
        const chatId = msgObj.chatId || msgObj.group_id || msgObj.user_id; 
        
        if (!senderId || senderId === 'undefined') return null;

        const isMaster = hasPermission(senderId, 'master');

        // ==========================================
        // 🌟 功能块 1：[ 前缀管理指令 ] 仅限大主人使用
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
        // 🌟 功能块 2：[ 白名单管理指令 ] 仅限大主人使用
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
                    return `🛡️ 当前指令白名单配置：\n状态：${wl.enable ? '✅ 启用' : '❌ 禁用'}\n特权指令：${wl.list && wl.list.length > 0 ? wl.list.join(' , ') : '空'}`;
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
        if (pureText === '帮助') {
          try {
            // 🌟 核心修复：把 chatId 传进去，生成针对该群的动态图片！
            const imagePath = await generateHelpCard(chatId);
            const buffer = fs.readFileSync(imagePath);
            return { file: buffer };
          } catch (e) {
            console.error('生成帮助卡片失败:', e);
            return '❌ 获取帮助失败';
          }
        }

        // ==========================================
        // [ 状态 ] 指令
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
          return '🔷 机器人正在重启，请稍候...';
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
              return '❌ 重载入口未配置，请先在 adapter.js 中注册全局重载函数。';
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
          return '🔷 机器人已关闭。';
        }

        return null;
  }
};