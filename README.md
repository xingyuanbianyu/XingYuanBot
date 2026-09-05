# 🌟 XingYuanBot（星缘机器人）

一个基于 Node.js 的轻量级 QQ 机器人框架，支持 NapCat / LLOneBot 协议端连接，内置灵活的权限管理系统和插件扩展机制。

## 反馈方式
- 私聊反馈
- 电子邮箱：m1536_adjs318inp@aka.yeah.net
- QQ反馈：3381673433

- 公开反馈
- QQ群反馈：1026165109
- Issues中进行反馈
- Gutee[报告Bug](https://gitee.com/starry-language/XingYuanBot/issues/IK9BZH)
- Gitee[功能建议](https://gitee.com/starry-language/XingYuanBot/issues/IK9BZM)
- GitHub[报告Bug](https://github.com/xingyuanbianyu/XingYuanBot/issues/1)
- GitHub[功能建议](https://github.com/xingyuanbianyu/XingYuanBot/issues/2)
- GitCode[报告Bug](https://gitcode.com/xingyuan3739/XingYuanBot/issues/1)
- GitCode[功能建议](https://gitcode.com/xingyuan3739/XingYuanBot/issues/2)

## ✨ 功能特性

- 📡 支持 NapCat、LLOneBot 协议端连接
- 🔐 多级权限管理（大主人 / 小主人 / 管理员 / 普通成员）
- 🔌 插件化架构，轻松扩展功能，插件直接放xy-plugins下，先写rule.json，再写index.js或者script.py（随便选，只要能够作为启动或者入口文件即可），最好还是按照插件启动，文件里面的要求填写
这是一个rule.json的配置示例：
```
{
  "name": "系统指令",
  "type": "command",
  "prefix": ["#", "/"],
  "keywords": ["退出", "重启", "状态", "帮助", "权限"],
  "entry": "index.js"
}
```
- 💾 基于 Redis 的数据存储(暂不支持)

## 🚀 快速开始

### 环境要求

- 暂时只支持windows系统
- Node.js 18+
- Redis 数据库（不需要，待开发中，仅作为后续选择）
- NapCat / LLOneBot 协议端
- 如果没有以上两个协议端，请先前往任意一个地址进行安装
- [安装NapCat地址](https://github.com/NapNeko/NapCatQQ/releases)
- [安装LLOneBot地址](https://github.com/LLOneBot/LuckyLilliaBot/releases)
- python 3X（仅运行环境要求）

### 安装步骤

克隆仓库
国内用户使用这个
```
git clone https://gitee.com/starry-language/XingYuanBot.git
```
国外用户使用这个
```
git clone https://github.com/xingyuanbianyu/XingYuanBot.git
```
GitCode用户使用这个
```
git clone https://gitcode.com/xingyuan3739/XingYuanBot.git
```
统一使用下面这个指令进入项目目录
```
cd XingYuanBot
```

### 安装依赖
```
pnpm install
```
如果没有pnpm，请先运行如下指令安装
```
npm install -g pnpm
```
### 配置与启动

- 已经实现自动创建配置，只需要启动项目，连接上协议端，具体如何设置主人，请看下面

### 运行主程序：
```
# 方式一：标准启动（推荐）
node app.js

# 方式二：带自动重启守护（需 Python 环境）
python script.py
```
这是使用pnpm进行启动
```
pnpm app或者pnpm run app → node app

pnpm py或者pnpm run py → python script.py
```
### 端口设计

- 3000 http服务端
- 3002 http服务端

### 端口介绍

- 3000 该端口为发送消息设计
- 3002：群管专用接口（处理禁言、踢人等指令）

### 📅 开发计划 (Roadmap)

- 基础消息监听与回复
- 权限管理系统
- Redis / SQLite 数据持久化支持
- 更多实用插件(签到等)

### 已优化点
- 优化了重启逻辑
```
优化了重启指令的执行逻辑，并且启动一个脚本杀掉占用端口进程，并且重开一个窗口终端，该脚本为根目录里面的script.py文件，需要python环境
```
- 添加了禁言、踢人、解禁功能
```
已经完成，可使用指令通过 #帮助 获取
```
- 优化了菜单卡片
```
优化了帮助菜单，从静态卡片变成了动态卡片，只需要修改menu.json文件
```
- 优化了群管插件的逻辑
```
添加了点赞功能和头衔功能
```
- 添加了引用撤回
```
引用后使用#撤回，即可撤回
```
- 优化了设置主人逻辑

| 指令 | 谁能用 | 说明 |
| :--- | :--- | :--- |
| 设置主人 | 任何人 |	无大主人时触发验证码 |
| 设置主人 QQ 验证码 |	任何人 |	输入验证码完成大主人设置 |
| 设置小主人 QQ |	仅大主人 |	添加小主人（默认权限关闭）|
| 取消主人 QQ |	仅大主人 |	移除指定小主人，不能取消自己 |
| 权限状态 开 QQ |	仅大主人 |	恢复指定小主人权限|
| 权限状态 关 QQ |	仅大主人 |	将指定小主人权限设为0 |
| 权限状态 查询 QQ |	任何人 | 	查询某人权限是否失效 |

- 添加了服务端，还有客户端的链接
```
端口分别是服务端3001和客户端3004
```
- 重新优化了撤回功能
```
解决了无法撤回的问题，添加了群聊撤回以及撤回发消息的撤回指令
```
- 更新了插件分组功能
```
启动或禁用插件功能请进入xy-plugins/plugin-group目录，编辑config.yaml，只需要将enabled的值改成false或者true
false代表禁用
true代表启动
```
- 添加了黑名单和白名单功能
```
添加进黑名单的用户或者群聊，不会进行处理
白名单功能，具体有什么功能尚未开发
```
- 优化了客户端与服务端的配置
```
打开xy-data文件夹找到bot_server.yaml或者bot_clint.yaml修改配置即可，下载即配置好了，以下配置
bot_server.yaml的
server:
    host: 127.0.0.1
    port: 3001
    token: ''
bot_clinet的
clinet:
    host: 127.0.0.1
    port: 3004
    token: ''
只需要修改你对应的服务端或者客户端即可        
```
- 待上传的优化
