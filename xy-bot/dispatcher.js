// xy-bot/dispatcher.js

export class PluginDispatcher {
  constructor(plugins) {
    this._getPlugins = typeof plugins === 'function' ? plugins : () => plugins;
  }

  get plugins() {
    return this._getPlugins() ?? [];
  }

  async dispatch(msg, activePlugins, context = {}) {
    const priorityPlugins = context.priorityPlugins || globalThis._priorityPlugins || new Set();
    const interactiveSessions = context.interactiveSessions || globalThis._interactiveSessions || new Map();

    const session = interactiveSessions.get(msg.senderQQ);
    if (session && session.expireAt > Date.now()) {
        const targetPlugin = activePlugins.find(p => (p.handler?.name || p.name) === session.pluginName);
        if (targetPlugin) {
            await this.runPlugin(targetPlugin, msg, context, true); 
            return; 
        }
    }

    for (const plugin of activePlugins) {
      if (!plugin || !plugin.handler) continue;

      const pluginName = plugin.handler.name || plugin.name || '未知';
      const isPriority = priorityPlugins.has(pluginName);

      const handled = await this.runPlugin(plugin, msg, context, false);

      if (handled && !isPriority) {
        break; 
      }
    }
  }

  async runPlugin(plugin, msg, context = {}, forceExecute = false) {
    const raw = plugin.handler;
    if (!raw) return false;

    let matchFn = null;
    let handleFn = null;

    if (typeof raw === 'function') {
      handleFn = raw;
    } else if (typeof raw === 'object' && raw !== null) {
      if (typeof raw.match === 'function') matchFn = raw.match.bind(raw);
      if (typeof raw.handle === 'function') handleFn = raw.handle.bind(raw);
    }

    if (!handleFn) return false;

    const pluginName = raw.name || plugin.name || '未知';
    const priorityPlugins = context.priorityPlugins || globalThis._priorityPlugins || new Set();
    const cmdConfig = context.cmdConfig || globalThis._cmdConfig || { enable: true, prefixes: ['/', '#'] };
    const whitelistConfig = context.whitelistConfig || globalThis._whitelistConfig || { enable: false, list: [] };
    const interactiveSessions = context.interactiveSessions || globalThis._interactiveSessions || new Map();

    let finalPureText = (msg.pureText || "").trim();

    if (!forceExecute) {
        const isPriority = priorityPlugins.has(pluginName);
        let hasValidPrefix = false;
        let isAdminCmd = false;
        let isWhitelisted = false;

        // ============================================================
        // 🌟 阶段 1：统一剥离前缀（不管是普通插件、priority 还是 ignorePrefix，全都要剥！）
        // ============================================================
        if (!msg._isMapped) {
            for (const p of cmdConfig.prefixes) {
              if (finalPureText.startsWith(p)) {
                hasValidPrefix = true;
                finalPureText = finalPureText.slice(p.length).trim(); 
                break;
              }
            }
            
            isAdminCmd = /^(启用前缀|禁用前缀|查询前缀|添加前缀|删除前缀|启用指令白名单|禁用指令白名单|查询指令白名单|添加指令白名单|删除指令白名单|重启|重载)/.test(finalPureText);

            if (!hasValidPrefix && !isAdminCmd && whitelistConfig.enable && whitelistConfig.list.length > 0) {
              for (const word of whitelistConfig.list) {
                if (finalPureText === word) {
                  isWhitelisted = true;
                  break;
                }
              }
            }
        }

        // ============================================================
        // 🌟 阶段 2：拦截判断（只针对普通插件，priority 和 ignorePrefix 免死，映射过的也免死）
        // ============================================================
        if (!isPriority && !raw.ignorePrefix) {
            // 🌟 核心修复：加入 !msg._isMapped 判断，防止映射指令被误杀！
            if (cmdConfig.enable && !hasValidPrefix && !isAdminCmd && !isWhitelisted && !msg._isMapped && finalPureText) {
                return false;
            }
        }

        // ============================================================
        // 🌟 阶段 3：执行 match 校验（如果插件写了 match，无论是不是 priority 都要过）
        // ============================================================
        if (matchFn) {
          try {
            if (!matchFn(finalPureText, msg)) return false; 
          } catch (e) { return false; }
        }
    } else {
        // 强制劫持模式（如入群验证），保留原始未剥离文本（如果插件内部需要）
        finalPureText = (msg.pureText || "").trim();
    }

    // 构造发送给插件的消息体并执行
    const pluginMsg = {
      ...msg,               
      ...msg.rawData,       
      content: msg.content,               
      text: msg.message || [],            
      pureText: finalPureText, 
      raw_message: msg.raw_message,
      botId: msg.botId, 
      _ws: msg._ws
    };

    try {
      const result = await handleFn(pluginMsg);
      
      if (!result) return false;

      if (result && typeof result === 'object' && result.__interceptNext === true) {
          interactiveSessions.set(msg.senderQQ, { 
              pluginName: pluginName, 
              expireAt: Date.now() + 3 * 60 * 1000 
          });
      }

      if (typeof result === 'string') {
        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result, botId: msg.botId, _ws: msg._ws });
        return true; 
      } else if (result.file) {
        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, file: result.file, botId: msg.botId, _ws: msg._ws });
        return true;
      } else if (result.content || result.message) {
        globalThis.bot.send({ chatId: msg.chatId, isGroup: msg.isGroup, content: result.content || result.message, botId: msg.botId, _ws: msg._ws });
        return true;
      }
      
      if (result === true) return true;
      return false;
    } catch (e) {
      globalThis.print(`[插件报错] ${pluginName}: ${e.message}`);
      return false;
    }
  }
}