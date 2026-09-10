# XingYuanBot项目目录结构
```
XingYuanBot 项目根目录
   ├───fonts 字体文件夹
   │      └─ NotoSansSC-Regular.otf 字体文件
   ├───xy-bot 核心目录
   │       ├─adapter.js 核心框架，事件分发，消息处理
   │       ├─bridge.js 入群提示和退群提示处理核心
   │       ├─bridge.py 监听协议端的ws协议入群和退群事件
   │       ├─plugin-loader.js 插件核心加载器
   │       ├─command.js 后台管理核心
   │       └─config.js 读取黑名单返回数据
   ├───xy-plugins 插件目录
   │       ├─指令 基础指令
   │       │  ├─rule.json 规则文件
   │       │  ├─index.js 指令处理文件
   │       │  ├─menu.json 帮助菜单文件
   │       │  └─card.js 帮助图片生成文件
   │       ├─qroup-plugin 群管插件
   │       │     ├─rule.json 规则文件
   │       │     └─index.js 群管指令处理文件
   │       ├─Set_Owner-plugin 权限管理插件
   │       │     ├─rule.json 规则文件
   │       │     └─index.js 权限管理文件
   │       ├─guote-recall 撤回插件
   │       │     ├─rule.json 规则文件
   │       │     └─index.js 撤回处理文件
   │       └─plugin-group 子插件加载器
   │             ├─rule.json 规则文件
   │             ├─index.js 子插件启动器
   │             ├─config.yaml 子插件配置文件
   │             └─plugin 子插件目录
   ├───xy-data 核心数据目录
   │       ├─bot_server.yaml Bot服务端配置
   │       ├─bot_client.yaml Bot客户端配置
   │       └config.yaml 黑名单配置
   ├───xy-config 核心配置目录
   │       ├─config 权限配置目录
   │       │    ├─permissions.js 权限检测器
   │       │    └─config.yaml.example 权限配置模板
   │       └─config.yaml 后台管理员配置
   ├───temp 数据目录和临时数据
   │      └─vris 回复库
   │           └─vris.yaml 入群提示和退群提示配置
   ├───xy-lib 外部模块库与内置模块库
   │       └─bot.js 初始化命令行
   ├───script.py 重启脚本
   └───app.js 启动入口
```