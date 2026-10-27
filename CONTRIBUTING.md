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
└── XXX/
        └─hello
              ├── rule.json    # 插件描述文件（必须）
              ├── index.js     # 插件入口文件（必须）
              └── README.md    # 使用说明（推荐）
```
### 📦 插件开发示例

在 `xy-plugins/` 下创建文件夹（例如 `hello`），并添加以下两个文件：

**1. `rule.json` (插件配置)**
```json
{
  "name": "你好世界",
  "enabled": true,
  "type": "command",
  "entry": "index.js"
}
```
- index.js
```js
export default {
  name: '你好世界',

  // 匹配规则：剥离前缀后的纯文本为“你好”时触发
  match(text) {
    return text === '你好';
  },

  // 处理逻辑
  async handle(msg) {
    return [
      { type: 'at', data: { qq: msg.senderQQ } },
      { type: 'text', data: { text: ' 你好！欢迎使用 XingYuanBot 4.0.0 🎉' } }
    ];
  }
};
```

## 制作共享库教程
- 1.了解加载规则
- .mjs 强制import()加载
- .cjs 强制require()加载
- .js 根据package.json的type字段，"type": "module"使用import()加载，其他字段使用require()加载

- 2.lib.json示范
```json
{
    "enable": true,
    "entries": ["index.js"]
}
```
entries字段，根据实际入口文件填写

- 3.如何编写共享库文件
```js
// ===== xy-lib/fl/index.js =====

console.log("✅ [xy-lib] fl 模块已加载");

// 1. 全局随机数
globalThis.random = function(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};
```
这个仅为示例

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

## 允许自建仓库，也允许任何魔改

---

## 交流

如果你有任何问题或想法，欢迎提交 **Issue** 讨论。

感谢你的贡献！
