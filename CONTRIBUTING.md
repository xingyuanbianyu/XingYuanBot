# XingYuanBot 贡献指南

本项目采用 **MIT 开源协议**，你可以在任意平台 Fork 本项目进行开发和使用，无需额外授权。

本项目已在 **GitHub**、**Gitee**、**GitCode** 三个平台同步开源，你可以在任意平台提交 PR。

---

## 贡献范围

本项目采用"核心 + 插件"架构：

| 贡献类型 | 说明 |
| :--- | :--- |
| 开发新插件 | 在 `xy-plugins/` 下新建插件目录，或独立维护自己的插件仓库 |
| 修复 Bug | 发现核心代码或已有插件的问题，提交 Issue 或 PR |
| 完善文档 | 补充使用说明、部署教程、插件示例 |
| 修改核心代码 | `xy-bot/` 目录由作者维护，如需修改请先提交 Issue 讨论 |

> 插件开发者和使用者完全自由：你可以选择将插件放在本项目仓库内，也可以独立维护自己的仓库，甚至商用——MIT 协议已赋予你全部权利。

---

## 插件开发

如果你想在主仓库内开发插件，请参考以下规范：

### 目录结构

在 `xy-plugins/` 下新建你的插件文件夹：

```
xy-plugins/
└── my-plugin/
    ├── rule.json    # 插件描述文件（必须）
    ├── index.js     # 插件入口文件（必须）
    └── README.md    # 使用说明（推荐）
```

### rule.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "author": "你的名字",
  "entry": "index.js"
}
```

`entry` 字段指定入口文件名，不填则默认为 `index.js`。

### 插件代码模板

`plugin-loader.js` 会加载你的入口文件，需 `export default` 一个包含 `match` 和 `handle` 的对象：

```javascript
export default {
  match: (text) => {
    return text.startsWith('/hello')
  },

  handle: async (msg) => {
    // msg.text    - 消息内容
    // msg.chatId  - 会话ID
    // msg.isGroup - 是否群聊
    // msg.senderName - 发送者昵称
    // msg.senderQQ  - 发送者QQ号
    // msg.role    - 发送者角色

    console.log(`收到消息：${msg.text}，来自 ${msg.senderName}`)
    // 发送回复：await adapter.sendMsg(msg.chatId, '你好！')
  }
}
```

---

## 提交 PR 流程

1. **Fork** 本仓库到你的账户（GitHub / Gitee / GitCode 任意平台）
2. **Clone** 到你的本地：
   ```bash
   git clone https://github.com/yourname/XingYuanBot.git
   cd XingYuanBot
   ```
3. **新建分支**：
   ```bash
   git checkout -b feat/你的插件名
   ```
4. **开发并提交**你的修改
5. **推送并发起 Pull Request** 到本仓库的 `main` 分支

---

## Commit 规范

格式：`<type>(<scope>): <subject>`

| type | 说明 |
| :--- | :--- |
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档修改 |
| `refactor` | 代码重构 |
| `chore` | 配置/杂项 |

**示例：**

```
feat(plugin/recall): 添加批量撤回功能
fix(plugin/group): 修复禁言权限判断问题
docs: 补充插件开发文档
```

---

## 交流

如果你有任何问题或想法，欢迎提交 **Issue** 讨论。

感谢你的贡献！
