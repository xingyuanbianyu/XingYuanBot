# 🌟 XingYuanBot（星缘机器人）

一个基于 Node.js 的轻量级 QQ 机器人框架，支持 NapCat / LLOneBot 协议端连接，内置灵活的权限管理系统和插件扩展机制。
# 当前版本：4.0.0
## 项目目录结构

<details>

<summary>👉 点击查看项目目录</summary>

- [Gitee-项目目录](https://gitee.com/starry-language/XingYuanBot/blob/master/open-source%20project%20planning.md)
- [GitHub-项目目录](https://github.com/xingyuanbianyu/XingYuanBot/blob/master/open-source%20project%20planning.md)
- [GitCode-项目目录](https://gitcode.com/xingyuan3739/XingYuanBot/blob/master/open-source%20project%20planning.md)

</details>

## ✨ 功能特性

- 📡 **协议端支持**：完美兼容 NapCat、LLOneBot 等 OneBot 11 协议端连接。
- 🔐 **多级权限管理**：内置大主人 / 小主人 / 管理员 / 普通成员四级权限，支持指令动态管理。
- 🔌 **插件化架构**：在 `xy-plugins` 目录下创建插件文件夹，编写 `rule.json` 和入口文件即可热加载运行。
- 🚀 **全链路 WebSocket**：底层直连 WS，自带心跳保活、断线重连与 Token 鉴权，响应零延迟。
- ♻️ **插件热重载**：修改插件代码后无需重启主控，终端输入 `reload` 即可增量更新。



## 🚀 快速开始

## 环境要求

- 下载安装 [Visual Studio Build Tools](https://aka.ms/vs/17/release/vs_buildtools.exe)，
安装时勾选「使用 C++ 的桌面开发」工作负载

---

- [Node.js](https://nodejs.org/zh-cn/download)建议安装24.21.0版本
- NapCat / LLOneBot 协议端
<details>
<summary>👉 点击查看协议端下载地址</summary>

如果没有以上两个协议端，请先前往任意一个地址进行安装：

- **NapCat**: [下载 NapCat](https://github.com/NapNeko/NapCatQQ/releases)
- **LLOneBot**: [下载 LLOneBot](https://github.com/LLOneBot/LuckyLilliaBot/releases)

</details>

- Windows [python3.14.7安装包](https://www.python.org/ftp/python/3.14.7/python-3.14.7-amd64.exe)
- Linux系统
- Debian
```bash
apt update
apt install -y python3 build-essential python-is-python3
```
- RHEL
```bash
yum groupinstall -y "Development Tools"
yum install -y python3
ln -sf /usr/bin/python3 /usr/bin/python
```

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
- 构建脚本
```bash
Linux请依次执行
chmod +x setup.sh
./setup.sh

Windows请双击
setup.bat
```

### 安装依赖
- 1.请先执行
```bash
pnpm -v
```
没有输出版本号或者提示不是内部或外部指令，则执行2
<br>
如果输出了版本号，直接执行3，跳过2

- 2.如果没有pnpm，请先运行如下指令安装
```bash
npm install -g pnpm
```

- 3.执行下面命令
```bash
pnpm install
```

### 配置与启动

- 已经实现自动创建配置，只需要启动项目，连接上协议端，具体如何设置主人，请看权限管理插件

#### 运行主程序：
```
# 方式一：标准启动（推荐）
node --no-warnings app.js / node app.js

# 方式二：重启加启动（需 Python 环境）
python script.py

这是使用pnpm进行启动

pnpm app或者pnpm run app → node --no-warnings app

pnpm py或者pnpm run py → python script.py
```
### 权限管理插件
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

- 已完全通过ws进行

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

- [Gitee-CHANGELOG文档](https://gitee.com/starry-language/XingYuanBot/blob/master/CHANGELOG.md)
- [GitHub-CHANGELOG文档](https://github.com/xingyuanbianyu/XingYuanBot/blob/master/CHANGELOG.md)
- [GitCode-CHANGELOG文档](https://gitcode.com/xingyuan3739/XingYuanBot/blob/master/CHANGELOG.md)

</details>

### 📅 开发计划 (Roadmap)

- 基础消息监听与回复
- 权限管理系统
- Redis / SQLite 数据持久化支持
- 更多实用插件(签到等)

# XingYuanBot交流群：
- Q群:
```
1103117017
```