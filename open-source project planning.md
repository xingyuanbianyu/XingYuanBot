# XingYuanBot项目目录结构
```
XingYuanBot 项目根目录
   ├───adapter 适配器目录
   │        └─adapters
   │               └─onebot (原ontbot)
   │                     ├─index.js OneBot协议适配器
   │                     └─adapter.json 适配器配置
   ├───fonts 字体文件夹
   │      └─NotoSansSC-Regular.otf 字体文件（用于生成图片）
   ├───xy-bot 核心目录
   │       ├─adapter-registry.js 适配器加载器
   │       ├─dispatcher.js 插件分发器
   │       ├─message-parser.js 消息解析器
   │       ├─network.js 网络核心（支持正/反向WS自动竞争，内置全局 wsCall API）
   │       ├─message.js 统一内部消息格式
   │       ├─plugin-loader.js 插件核心加载器（支持热重载）
   │       ├─blacklist.js 黑名单管理器
   │       ├─bot.js 初始化命令行（终端保活CLI）
   │       ├─lib.cjs 注册全局变量和全局函数处理器
   │       └─config.js 全局配置读取器（支持文件监听热更新）
   ├───xy-plugins 插件目录
   │       ├─plugins 通用插件
   │       │   ├─指令 基础指令（帮助菜单、状态等）
   │       │   │  ├─rule.json 规则文件
   │       │   │  ├─index.js 指令处理文件
   │       │   │  ├─menu.json 帮助菜单数据
   │       │   │  └─card.js 帮助图片生成
   │       │   ├─event-settings
   │       │   │    ├─rule.json 规则文件
   │       │   │    └─index.js 执行文件
   │       │   ├─scheduler 定时任务插件
   │       │   │  ├─index.js 定时逻辑与轮询器
   │       │   │  └─scheduler.db 定时任务SQLite数据库
   │       │   └─plugin-group 子插件组加载器
   │       │              ├─rule.json 规则文件
   │       │              ├─index.js 子插件启动器
   │       │              ├─config.yaml 子插件配置文件
   │       │              └─plugin 子插件目录
   │       │                  └─index.jsl 群打卡插件
   │       └─QQ QQ专属功能插件
   │            ├─group-plugin (原qroup-plugin) 群管插件
   │            │      ├─rule.json 规则文件
   │            │      └─index.js 群管指令处理
   │            ├─Set_Owner-plugin 权限管理插件
   │            │    ├─rule.json 规则文件
   │            │    └─index.js 权限管理逻辑
   │            ├─guote-plugin 工具箱
   │            │    ├─rule.json 规则文件
   │            │    └─index.js 具体执行文件
   │            ├─anti-recall 防撤回插件
   │            │    ├─rule.json 规则文件
   │            │    └─index.js 防撤回拦截处理
   │            └─group-events 群事件提示插件
   │                 ├─rule.json 规则文件
   │                 └─index.js 入群/退群事件处理
   ├───xy-data 核心数据目录
   │       ├─bot_server.yaml Bot服务端WS配置
   │       ├─bot_client.yaml Bot客户端WS配置
   │       ├─config.yaml 全局黑名单/白名单配置
   │       └─owner.json 自动记录的号主QQ数据
   ├───xy-config 核心配置目录
   │       ├─config 权限配置目录
   │       │    ├─permissions.js 权限检测器（支持热更新）
   │       │    ├─bot.yaml 点赞功能配置文件
   │       │    └─config.yaml.example 权限配置模板
   │       ├─priority.yaml 插件优先级配置文件
   │       └─config.yaml 基础行为配置（前缀、白名单）
   ├───temp 临时数据缓存目录
   │      ├─card 生成的卡片图片
   │      ├─group 生成的群数据图片
   │      └─vris 回复库
   │           └─vris.yaml 入群/退群提示模板
   ├───xy-lib 外部模块库与内置模块库
   │           ├─fl 基础工具库 (网络、数据库、日志等核心封装)
   │           └─.gitkeep 占位文件
   ├───web-panel.js 网页端控制面板启动器
   ├───script.py 跨平台重启守护脚本
   ├───app.js 启动总入口
   ├───package.json 项目依赖与启动脚本
   └───README.md 项目说明文档
```