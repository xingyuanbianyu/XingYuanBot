📦 更新日志 (CHANGELOG)

[2.9.0] - 2026-09-09

✨ 新增功能

· 正/反向连接支持：新增服务端 (3001 端口) 与客户端 (3004 端口) 配置，支持通过 xy-data 自动生成。
· 入群/退群动态提示：支持通过修改 temp/vris/vris.yaml 中的 welcome、decrease、kick 字段自定义提示语。
· 引用撤回与消息撤回：解决了无法撤回的问题，支持引用消息后使用 #撤回。
· 全新黑白名单机制：加入黑名单的用户或群聊将不处理消息。配置路径：xy-data/config.yaml（注：白名单具体功能后续开发）。
· 群管工具增强：新增点赞、禁言、踢人、解禁、改头衔等完整群管指令。
· 插件分组功能：支持在 xy-plugins/plugin-group/config.yaml 中通过 enabled: true/false 批量启停子插件。

🛠️ 优化项

· 重启逻辑重构：引入 script.py，支持一键杀进程、重启并弹出新终端窗口（需 Python 环境）。
· 动态菜单卡片：帮助菜单从静态升级为动态卡片，只需修改 menu.json 即可实时更新，并支持图片生成 (card.js)。

---

[2.9.5] - 2026-09-11

✨ 新增功能

· 插件热重载：支持通过 #重载 或 /重载 指令动态重载插件代码，无需重启整个机器人。
· 全局模块注册 (xy-lib)：支持在 xy-lib 目录下创建自定义模块库。
  · 配置 lib.json：enable (是否启用)、entries (入口文件，支持数组声明多个)。
· 改头衔指令：支持管理员及以上身份修改群成员头衔。
  · 用法：#改头衔 @某某 新头衔

---

[3.0.0] - 2026-10-22

⚠️ 重大架构升级：全链路 WebSocket 直连重构。本次更新涉及底层通信与插件调用逻辑，强烈建议重新执行 pnpm install 并检查插件配置。

🚀 核心架构重构 (Core Refactor)

· 彻底移除 HTTP 依赖，全面拥抱 WebSocket：底层 network.js 新增 globalThis.wsCall 方法。所有内置插件（打卡、群管、防撤回等）已放弃原有的 fetch('http://127.0.0.1:3000') 请求，全部改为直连 WS 发送 API。
  · 优势：彻底摆脱 HTTP 端口硬编码，请求零延迟，自带 15 秒超时控制与 Promise 拦截。
· 新增独立发送器 sender.js：将原本臃肿的 app.js 发送逻辑抽离。
  · 优势：通过 bindWs 动态绑定当前活跃的 WS 连接，无论断线重连还是正反向切换，插件只需调用 bot.send 永不丢包。
· 网络双端竞争机制优化：完善了 Server 与 Client 的抢占逻辑，补全了底层 ws.on('error') 捕获，避免单个连接报错导致整个进程崩溃。

🛠️ 功能与性能优化 (Features & Optimization)

· 真正的配置热更新：重构 config.js 与 permissions.js。
  · 引入 fs.watch 与文件修改时间 (mtime) 缓存机制。修改 config.yaml 后无需重启，下一条指令即刻生效，同时避免了频繁读取磁盘的性能损耗。
· 插件加载器瘦身：精简了 adapter-registry.js，移除了与底层网络耦合的 mountNetwork 方法，使其只专注于数据解析。
· Python 守护脚本升级：
  · 废弃了暴力的 kill -9，改用 SIGTERM 触发 Node.js 优雅退出，防止 SQLite 数据库损坏 (WAL 模式锁死)。
  · 支持 python script.py -d Linux 后台静默守护运行。

🐛 问题修复 (Bug Fixes)

· 修复权限判定失效：解决了 permissions.js 中 String 与 Number 比较导致的“明明配置了主人却提示无权限”的 Bug。
· 修复定时任务死循环：修复了 scheduler 插件在注入伪消息失败时导致的无限重试、日志刷屏问题。
· 修复路径引用崩溃：解决了部分插件因相对路径过深（../../../../）导致找不到权限模块的隐患。