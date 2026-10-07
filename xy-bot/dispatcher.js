// xy-bot/dispatcher.js
// ✅ 插件分发器
// 职责：遍历插件 → 调用 handler → 处理返回值 → 触发发送

import { sendMessage } from './sender.js';

export class PluginDispatcher {
  constructor(plugins) {
    this.plugins = Array.isArray(plugins) ? plugins : [];
  }

  // ========================
  // 分发一条消息给所有插件
  // ========================
  async dispatch(msg) {
    for (const plugin of this.plugins) {
      if (!plugin || !plugin.handler) continue;

      try {
        const result = await this.runPlugin(plugin, msg);

        // 插件返回空值 → 视为“不处理”，继续下一个插件
        if (result === null || result === undefined || result === false || result === '') {
          continue;
        }

        // 有返回值 → 发送，然后结束（不再传给后续插件）
        this.handleResult(msg, result);
        return;

      } catch (e) {
        print(`[插件报错] ${plugin.name}: ${e.message}`);
        // 单个插件报错不影响其他插件
        continue;
      }
    }
  }

  // ========================
  // 执行一个插件的 handler
  // ========================
  async runPlugin(plugin, msg) {
    const raw = plugin.handler;
    let handleFn = null;

    if (typeof raw === 'function') {
      handleFn = raw;
    } else if (raw && typeof raw.handle === 'function') {
      handleFn = raw.handle.bind(raw);
    }

    if (!handleFn) return undefined;

    // 构造传给插件的 msg（只补必要的兼容字段）
    const pluginMsg = {
      ...msg,
      isGroup: msg.isGroup === true || msg.chatType === 'group',
      text: msg.text ?? msg.content,
    };

    return await handleFn(pluginMsg);
  }

  // ========================
  // 处理插件返回值 → 发送
  // ========================
  handleResult(msg, result) {
    const isGroup = msg.isGroup === true;
    const chatId = msg.chatId;

    // 1. 纯字符串
    if (typeof result === 'string') {
      sendMessage({ chatId, isGroup, content: result });
      return;
    }

    // 2. 对象 { content: '...' }
    if (result.content) {
      sendMessage({ chatId, isGroup, content: result.content });
      return;
    }

    // 3. 对象 { file: Buffer }
    if (result.file) {
      sendMessage({ chatId, isGroup, file: result.file });
      return;
    }
  }
}