# 🌟 XingYuanBot（星缘机器人）

一个基于 Node.js 的轻量级 QQ 机器人框架，支持 NapCat / LLOneBot 协议端连接，内置灵活的权限管理系统和插件扩展机制。

# 当前版本：3.0.0

## 项目目录结构

<details>
<summary>👉 点击查看项目目录</summary>

- [Gitee-项目目录](https://gitee.com/starry-language/XingYuanBot/blob/master/open-source%20project%20planning.md)
- [GitHub-项目目录](https://github.com/xingyuanbianyu/XingYuanBot/blob/master/open-source%20project%20planning.md)
- [GitCode-项目目录](https://gitcode.com/xingyuan3739/XingYuanBot/blob/master/open-source%20project%20planning.md)

</details>

## ✨ 功能特性

- 📡 支持 NapCat、LLOneBot 协议端连接（双端自动竞争机制）
- ⚡ 插件原生支持 WebSocket 直连调用 API（无需依赖 HTTP 端口）
- 🔐 多级权限管理（大主人 / 小主人 / 管理员 / 普通成员）
- 🔌 插件化架构，轻松扩展功能，支持消息指令与事件监听
- 🔄 配置与插件均支持热更新，修改即刻生效

## 🚀 快速开始

### 环境要求

- **Windows 用户**：需下载安装 [Visual Studio Build Tools](https://aka.ms/vs/17/release/vs_buildtools.exe)，安装时勾选「使用 C++ 的桌面开发」工作负载。
- **Node.js**：建议安装 `>= 24.21.0` 版本。
- **Python**：Windows 推荐 [Python 3.14.7](https://www.python.org/ftp/python/3.14.7/python-3.14.7-amd64.exe)。
- **协议端**：NapCat 或 LLOneBot。

<details>
<summary>👉 点击查看协议端下载地址</summary>

如果没有以上两个协议端，请先前往任意一个地址进行安装：
- **NapCat**: [下载 NapCat](https://github.com/NapNeko/NapCatQQ/releases)
- **LLOneBot**: [下载 LLOneBot](https://github.com/LLOneBot/LuckyLilliaBot/releases)

</details>

- **Linux 系统依赖准备 (Debian/Ubuntu)**：
  ```bash
  apt update
  apt install -y python3 build-essential python-is-python3 libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev