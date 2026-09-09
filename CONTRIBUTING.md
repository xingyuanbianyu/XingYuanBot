# XingYuanBot 贡献指南

本项目已在 **GitHub**、**Gitee**、**GitCode** 三个平台同步开源，你可以在任意平台 Fork 本项目进行开发。

---

## 📌 贡献方向

本项目采用"核心 + 插件"架构，欢迎以下形式的贡献：

| 方向 | 说明 |
|---|---|
| 🧩 **开发新插件** | 最欢迎！基于 `plugin-loader.js` 接口编写插件放入 `xy-plugins/` |
| 🐛 **修复 Bug** | 发现核心代码或已有插件的问题，提交 Issue 或 PR |
| 📖 **完善文档** | 补充使用说明、部署教程、插件示例 |

> ⚠️ `xy-bot/` 核心目录由作者维护，不接受外部 PR。如需修改核心逻辑，请先提交 Issue 讨论。

---

## 🧩 插件开发指南

### 基本结构

在 `xy-plugins/` 下新建文件夹，例如：
xy-plugins/
└── my-plugin/          # 你的插件名
├── rule.json       # [必须] 插件描述文件
├── index.js        # [必须] 插件入口文件
└── README.md       # [推荐] 插件使用说明


### rule.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "author": "你的名字",
  "entry": "index.js"
}

- 示例
```
export default {
  /**
   * 匹配规则：收到消息时调用
   * @param {string} text - 消息文本
   * @returns {boolean} 返回 true 则触发 handle
   */
  match: (text) => {
    return text.startsWith('/hello')
  },

  /**
   * 处理逻辑：match 返回 true 后执行
   * @param {Object} msg - 消息对象
   * @param {string} msg.text - 消息内容
   * @param {string} msg.chatId - 会话ID
   * @param {boolean} msg.isGroup - 是否群聊
   * @param {string} msg.senderName - 发送者昵称
   * @param {string} msg.senderQQ - 发送者QQ号
   * @param {string} msg.role - 发送者角色
   */
  handle: async (msg) => {
    // 你的逻辑
    console.log(`收到消息: ${msg.text}，来自 ${msg.senderName}`)

    // 发送回复（根据你的 adapter.js 提供的接口）
    // 示例：await adapter.sendMsg(msg.chatId, '你好！')
  }
}
```
- 分支命名
```bash
git checkout -b feat/插件名-功能描述
git checkout -b fix/插件名-问题描述
```

Commit 格式
<type>(<scope>): <subject>

<type>: feat | fix | docs | refactor | chore
<scope>: 影响的模块名，如 plugin/recall

# 示例：
feat(plugin/recall): 添加批量撤回功能
fix(plugin/group): 修复禁言权限判断问题
docs: 补充插件开发文档

# 快速开始
# 1. Fork 本仓库
# 2. Clone 到你的本地
git clone https://github.com/yourname/XingYuanBot.git
cd XingYuanBot

# 3. 安装依赖
pnpm install

# 4. 修改配置
cp xy-data/bot_server.yaml.example xy-data/bot_server.yaml
cp xy-config/config.yaml.example xy-config/config/config.yaml

# 5. 启动
node app.js


