// xy-bot/dispatcher.js

export class PluginDispatcher {
  constructor(plugins) {
    this._getPlugins = typeof plugins === 'function' ? plugins : () => plugins;
    // 避免高频解析正则，将其提取到常量
    this.adminCmdRegex = /^(启用前缀|禁用前缀|查询前缀|添加前缀|删除前缀|启用指令白名单|禁用指令白名单|查询指令白名单|添加指令白名单|删除指令白名单)/;

    // ============================================================
    // 🌟 交互会话的通用匹配基础设施
    // ------------------------------------------------------------
    // session 里除"保留字段"外的所有键，都视为"必须等于 msg 上同名字段"的条件。
    // 为让插件能用 userId/groupId 这种直观名字，这里维护一份别名映射。
    // ============================================================
    this._sessionReserved = new Set(['pluginName', 'expireAt', 'matcher', 'priority']);
    this._fieldAlias = {
      userId: 'senderQQ',
      qq: 'senderQQ',
      senderId: 'senderQQ',
      groupId: 'chatId',
      group: 'chatId',
    };
  }

  get plugins() {
    return this._getPlugins() ?? [];
  }

  // 🌟 把 session 里的字段名解析成 msg 上的真实字段
  _resolveField(msg, name) {
    if (!msg) return undefined;
    if (Object.prototype.hasOwnProperty.call(msg, name)) return msg[name];
    const real = this._fieldAlias[name];
    if (real && Object.prototype.hasOwnProperty.call(msg, real)) return msg[real];
    return undefined;
  }

  // 🌟 遍历所有会话，返回条件最多（最精确）的那一条；一个条件都没有的会话视为无效
  _findSession(msg, sessions) {
    const now = Date.now();
    let best = null;
    let bestScore = -1;

    for (const [key, sess] of sessions) {
      if (!sess) { sessions.delete(key); continue; }
      if (!sess.expireAt || sess.expireAt <= now) { sessions.delete(key); continue; }

      let ok = true;
      let condCount = 0;

      // 自定义 matcher 最自由，也计入一个条件
      if (typeof sess.matcher === 'function') {
        condCount++;
        try { ok = !!sess.matcher(msg); } catch { ok = false; }
      }

      if (ok) {
        for (const [k, v] of Object.entries(sess)) {
          if (this._sessionReserved.has(k)) continue;
          if (v === undefined) continue;
          condCount++;
          const actual = this._resolveField(msg, k);
          if (actual === undefined || String(actual) !== String(v)) {
            ok = false;
            break;
          }
        }
      }

      // 条件越多越精确，优先返回；同条件数取先遍历到的
      if (ok && condCount > 0 && condCount > bestScore) {
        bestScore = condCount;
        best = { key, session: sess };
      }
    }
    return best;
  }

  // 🌟 登记交互会话：支持 true（默认群+人）或 { userId/groupId/.../matcher/ttl/key }
  _registerSession(interactiveSessions, pluginName, msg, interceptConfig) {
    const inc = (interceptConfig && typeof interceptConfig === 'object') ? interceptConfig : {};
    const ttl = typeof inc.ttl === 'number' ? inc.ttl : 3 * 60 * 1000;
    const session = {
      pluginName,
      expireAt: Date.now() + ttl,
    };

    // 把自定义条件字段并入（ttl/key 只用于配置，不参与匹配）
    for (const [k, v] of Object.entries(inc)) {
      if (k === 'ttl' || k === 'key') continue;
      session[k] = v;
    }

    // 没显式条件时，默认按"本群+本人"锁（保持旧行为向后兼容）
    const hasCond = (typeof session.matcher === 'function') ||
      Object.keys(session).some(k => !this._sessionReserved.has(k));
    if (!hasCond) {
      session.groupId = msg.chatId;
      session.userId = msg.senderQQ;
    }

    const key = inc.key
      ? String(inc.key)
      : `${pluginName}_${msg.chatId}_${msg.senderQQ}`;

    interactiveSessions.set(key, session);
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

    // ============================================================
    // 🌟 通用会话匹配：遍历所有 session，按字段/matcher 判断，命中一个就强制交给对应插件
    // ============================================================
    const sessionHit = this._findSession(msg, interactiveSessions);
    if (sessionHit) {
      const targetPlugin = activePlugins.find(
        p => (p.handler?.name || p.name) === sessionHit.session.pluginName
      );
      if (targetPlugin) {
        await this.runPlugin(targetPlugin, msg, context, true);
        return;
      }
      // 找不到对应插件（被卸载/改名），清掉这条死会话，继续正常分发
      interactiveSessions.delete(sessionHit.key);
    }

    // 正常插件遍历
    for (const plugin of activePlugins) {
      if (!plugin || !plugin.handler) continue;

      const pluginName = plugin.handler.name || plugin.name || '未知';
      const isPriority = priorityPlugins.has(pluginName);

      const handled = await this.runPlugin(plugin, msg, context, false);

      // 如果插件处理了消息，且不是旁路监听（priority），则终止后续分发
      if (handled && !isPriority) {
        (globalThis.print || console.log)(`[Dispatcher] 🛑 插件【${pluginName}】拦截了指令 "${msg.pureText}"，中止后续分发。`);
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

    // 🌟 前缀按长度倒序排列，防止短前缀吃掉长前缀（如 "#" 吃掉 "##"）
    const sortedPrefixes = [...(cmdConfig.prefixes || [])].sort((a, b) => b.length - a.length);

    for (const p of sortedPrefixes) {
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
    // 🌟 先铺底层 rawData，再用标准化 msg 覆盖，防止适配器解析好的 message(引用) 被覆盖丢失
    const pluginMsg = {
      ...(msg.rawData || {}),
      ...msg,
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

      // ============================================================
      // 🌟 登记交互会话：兼容 true（默认群+人）和自定义条件对象
      // ============================================================
      if (typeof result === 'object' && result.__interceptNext) {
        this._registerSession(interactiveSessions, pluginName, msg, result.__interceptNext);
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
        const file = result.file;
        const content = result.content || result.message;

        if (file || content) {
          this._safeSend({
            chatId: msg.chatId,
            isGroup: msg.isGroup,
            file: file,
            content: content,
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