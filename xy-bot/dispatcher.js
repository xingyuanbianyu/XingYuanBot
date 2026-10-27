// xy-bot/dispatcher.js

export class PluginDispatcher {
  constructor(plugins) {
    this._getPlugins = typeof plugins === 'function' ? plugins : () => plugins;
    // 避免高频解析正则，将其提取到常量
    this.adminCmdRegex = /^(启用前缀|禁用前缀|查询前缀|添加前缀|删除前缀|启用指令白名单|禁用指令白名单|查询指令白名单|添加指令白名单|删除指令白名单)/;
  }

  get plugins() {
    return this._getPlugins() ?? [];
  }

  // 🌟 统一安全发送函数，防止 globalThis.bot 未就绪导致崩溃
  _safeSend(options) {
    if (globalThis.bot && typeof globalThis.bot.send === 'function') {
      try {
        globalThis.bot.send(options);
      } catch (e) {
        (globalThis.print || console.error)(`❌ [Dispatcher] 消息发送失败: ${e.message}`);
      }
    } else {
      (globalThis.print || console.error)(`⚠️ [Dispatcher] globalThis.bot.send 未就绪，无法回复消息`);
    }
  }

  async dispatch(msg, activePlugins, context = {}) {
    const priorityPlugins = context.priorityPlugins || globalThis._priorityPlugins || new Set();
    const interactiveSessions = context.interactiveSessions || globalThis._interactiveSessions || new Map();

    // 🌟 修复 1：交互式会话的 Key 加上 chatId，防止跨群/私聊串台！
    const sessionKey = `${msg.chatId}_${msg.senderQQ}`;
    const session = interactiveSessions.get(sessionKey);
    
    if (session) {
      if (session.expireAt > Date.now()) {
        // 命中有效会话，强制交给特定插件处理
        const targetPlugin = activePlugins.find(p => (p.handler?.name || p.name) === session.pluginName);
        if (targetPlugin) {
          await this.runPlugin(targetPlugin, msg, context, true); 
          return; 
        }
      } else {
        // 会话已过期，主动删除，防止内存泄漏
        interactiveSessions.delete(sessionKey);
      }
    }

    // 正常插件遍历
    for (const plugin of activePlugins) {
      if (!plugin || !plugin.handler) continue;

      const pluginName = plugin.handler.name || plugin.name || '未知';
      const isPriority = priorityPlugins.has(pluginName);

      const handled = await this.runPlugin(plugin, msg, context, false);

      // 如果插件处理了消息，且不是旁路监听（priority），则终止后续分发
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
    const cmdConfig = context.cmdConfig || globalThis._cmdConfig || { enable: true, prefixes: ['/', '#'] };
    const whitelistConfig = context.whitelistConfig || globalThis._whitelistConfig || { enable: false, list: [] };
    const interactiveSessions = context.interactiveSessions || globalThis._interactiveSessions || new Map();

    let finalPureText = (msg.pureText || "").trim();

    // ============================================================
    // 阶段 1：统一剥离前缀
    // ============================================================
    let hasValidPrefix = false;
    // 🌟 修复 2：不论是强制接管还是正常匹配，都应该把前缀剥干净，防止用户输入 "/1234" 导致验证失败
    for (const p of cmdConfig.prefixes) {
      if (finalPureText.startsWith(p)) {
        hasValidPrefix = true;
        finalPureText = finalPureText.slice(p.length).trim(); 
        break;
      }
    }

    let isAdminCmd = this.adminCmdRegex.test(finalPureText);
    let isWhitelisted = false;

    if (!hasValidPrefix && !isAdminCmd && whitelistConfig.enable && whitelistConfig.list.length > 0) {
      if (whitelistConfig.list.includes(finalPureText)) {
        isWhitelisted = true;
      }
    }

    if (!forceExecute) {
        const isPriority = (context.priorityPlugins || globalThis._priorityPlugins || new Set()).has(pluginName);

        // ============================================================
        // 阶段 2：拦截判断
        // ============================================================
        if (!isPriority && !raw.ignorePrefix) {
            if (cmdConfig.enable && !hasValidPrefix && !isAdminCmd && !isWhitelisted && !msg._isMapped && finalPureText) {
                return false;
            }
        }

        // ============================================================
        // 阶段 3：执行 match 校验
        // ============================================================
        if (matchFn) {
          try {
            if (!matchFn(finalPureText, msg)) return false; 
          } catch (e) { 
            // 插件自定义的 match 写错了不应导致整个程序崩溃
            return false; 
          }
        }
    }

    // 构造插件消息体
    const pluginMsg = {
      ...msg,               
      ...(msg.rawData || {}),       
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

      // 设置交互式会话
      if (typeof result === 'object' && result.__interceptNext === true) {
          // 🌟 修复 1 配套：Key 也改为 chatId_senderQQ
          const sessionKey = `${msg.chatId}_${msg.senderQQ}`;
          interactiveSessions.set(sessionKey, { 
              pluginName: pluginName, 
              expireAt: Date.now() + 3 * 60 * 1000 
          });
          return false; 
      }

      // ============================================================
      // 🌟 统一处理返回值并发送消息
      // ============================================================
      if (typeof result === 'string') {
        this._safeSend({ chatId: msg.chatId, isGroup: msg.isGroup, content: result, botId: msg.botId, _ws: msg._ws });
        return true; 
      } 
      
      if (typeof result === 'object' && result !== null) {
        const sendContent = result.file || result.content || result.message;
        if (sendContent) {
          this._safeSend({ 
            chatId: msg.chatId, 
            isGroup: msg.isGroup, 
            content: sendContent, 
            botId: msg.botId, 
            _ws: msg._ws 
          });
          return true;
        }
      }
      
      if (result === true) return true;
      return false;
    } catch (e) {
      (globalThis.print || console.error)(`❌ [插件报错] ${pluginName}:\n${e.stack || e.message}`);
      return false;
    }
  }
}