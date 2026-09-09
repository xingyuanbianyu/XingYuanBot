# 🌟 XingYuanBot（星缘机器人）

一个基于 Node.js 的轻量级 QQ 机器人框架，支持 NapCat / LLOneBot 协议端连接，内置灵活的权限管理系统和插件扩展机制。
# 当前版本：2.9.0
## 项目目录结构

<details>

<summary>👉 点击查看项目目录</summary>

- [Gitee-项目目录](https://gitee.com/starry-language/XingYuanBot/blob/master/open-source%20project%20planning.md)
- [GitHub-项目目录](https://github.com/xingyuanbianyu/XingYuanBot/blob/master/%C2%A0CHANGELOG.md)
- [GitCode-项目目录](https://gitcode.com/xingyuan3739/XingYuanBot/blob/master/%C2%A0CHANGELOG.md)

</details>

## ✨ 功能特性

- 📡 支持 NapCat、LLOneBot 协议端连接
- 🔐 多级权限管理（大主人 / 小主人 / 管理员 / 普通成员）
- 🔌 插件化架构，轻松扩展功能，插件直接在xy-plugins下创建插件文件夹，先写rule.json，再写index.js或者script.py（随便选，只要能够作为启动或者入口文件即可），最好还是按照插件启动，文件里面的要求填写
这是一个rule.json的配置示例：
```json
{
  "name": "系统指令",
  "type": "command",
  "prefix": ["#", "/"],
  "keywords": ["退出", "重启", "状态", "帮助", "权限"],
  "entry": "index.js"
}
```
- command类型的插件，请使用如下方法进行创建插件
```js
//match和handle
//match进行匹配
//handle处理逻辑
```

## 🚀 快速开始

### 环境要求

- Node.js 18+
- Redis 数据库（不需要，待开发中，仅作为后续选择）
- NapCat / LLOneBot 协议端
<details>
<summary>👉 点击查看协议端下载地址</summary>

如果没有以上两个协议端，请先前往任意一个地址进行安装：

- **NapCat**: [下载 NapCat](https://github.com/NapNeko/NapCatQQ/releases)
- **LLOneBot**: [下载 LLOneBot](https://github.com/LLOneBot/LuckyLilliaBot/releases)

</details>

- python 3X（仅运行环境要求）

### 安装步骤

<details>
<summary>👉 点击查看：克隆仓库命令</summary>

请根据你的网络环境，选择对应的命令进行克隆：

- Gitee克隆仓库指令
```bash
git clone https://gitee.com/starry-language/XingYuanBot.git
```
- GitHub克隆仓库指令
```bash
git clone https://github.com/xingyuanbianyu/XingYuanBot.git
```
- GitCode克隆仓库指令
```bash
git clone https://gitcode.com/xingyuan3739/XingYuanBot.git
```
</details>

统一使用下面这个指令进入项目目录
```bash
cd XingYuanBot
```

### 安装依赖
- 执行下面命令
```bash
pnpm install
```
- 如果没有pnpm，请先运行如下指令安装
```bash
npm install -g pnpm
```
- 如果某python脚本报错，请先执行
```bash
pip install -r requirements.txt
```
### 配置与启动

- 已经实现自动创建配置，只需要启动项目，连接上协议端，具体如何设置主人，请看下面

### 运行主程序：
```
# 方式一：标准启动（推荐）
node app.js

# 方式二：带自动重启守护（需 Python 环境）
python script.py

这是使用pnpm进行启动

pnpm app或者pnpm run app → node app

pnpm py或者pnpm run py → python script.py
```
- 权限管理插件
<details>
<summary>👉 点击查看权限指令</summary>

| 指令 | 谁能用 | 说明 |
| :--- | :--- | :--- |
| 设置主人 | 任何人 |	无大主人时触发验证码 |
| 设置主人 QQ 验证码 |	任何人 |	输入验证码完成大主人设置 |
| 设置小主人 QQ |	仅大主人 |	添加小主人（默认权限关闭）|
| 取消主人 QQ |	仅大主人 |	移除指定小主人，不能取消自己 |
| 权限状态 开 QQ |	仅大主人 |	恢复指定小主人权限|
| 权限状态 关 QQ |	仅大主人 |	将指定小主人权限设为0 |
| 权限状态 查询 QQ |	任何人 | 	查询某人权限是否失效 |

</details>

<br>

## 客户端与服务端配置

```yaml
# 配置说明：
# 1. 打开 xy-data 文件夹，找到 bot_server.yaml 或 bot_client.yaml
# 2. 根据实际部署情况修改对应配置文件
# 3. 首次运行后会自动生成默认配置，通常只需微调即可使用
#bot_server.yaml的配置
server:
    host: 127.0.0.1
    port: 3001
    token: ''

#bot_client.yaml的配置
client:
    host: 127.0.0.1
    port: 3004
    token: ''
#只需要修改你对应的服务端或者客户端即可        
```

### 端口设计

- 3000 http服务端，该端口为发送消息设计
- 3002 http服务端，群管必要端口（处理禁言、踢人等指令）

## 反馈方式
<details>
<summary>👉 点击私聊反馈</summary>

- 电子邮箱：
```
m1536_adjs318inp@aka.yeah.net
```
- QQ反馈：
```
3381673433
```
</details>
<details>
<summary>👉 点击公开反馈</summary>

- QQ群反馈：
```
1026165109
```
- Issues中进行反馈
<details>
<summary>👉 Gitee 反馈通道</summary>

- [报告 Bug](https://gitee.com/starry-language/XingYuanBot/issues/IK9BZH)
- [功能建议](https://gitee.com/starry-language/XingYuanBot/issues/IK9BZM)

</details>

<details>
<summary>👉 GitHub 反馈通道</summary>

- [报告 Bug](https://github.com/xingyuanbianyu/XingYuanBot/issues/1)
- [功能建议](https://github.com/xingyuanbianyu/XingYuanBot/issues/2)

</details>

<details>
<summary>👉 GitCode 反馈通道</summary>

- [报告 Bug](https://gitcode.com/xingyuan3739/XingYuanBot/issues/1)
- [功能建议](https://gitcode.com/xingyuan3739/XingYuanBot/issues/2)

</details>
</details>

## 优化日志

<details>

<summary>👉 点击展开查看更新日志</summary>

- [Gitee-CHANGELOG文档](https://gitee.com/starry-language/XingYuanBot/blob/master/%C2%A0CHANGELOG.md)
- [GitHub-CHANGELOG文档](https://github.com/xingyuanbianyu/XingYuanBot/blob/master/open-source%20project%20planning.md)
- [GitCode-CHANGELOG文档](https://gitcode.com/xingyuan3739/XingYuanBot/blob/master/open-source%20project%20planning.md)

</details>

### 📅 开发计划 (Roadmap)

- 基础消息监听与回复
- 权限管理系统
- Redis / SQLite 数据持久化支持
- 更多实用插件(签到等)


