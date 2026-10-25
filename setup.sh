#!/bin/bash

# 获取当前脚本所在目录并进入
cd "$(dirname "$0")"

echo "======================================"
echo "🚀 开始构建 XingYuanBot 运行环境"
echo "======================================"

# 1. 检查 Node.js 环境
if ! command -v node &> /dev/null; then
    echo "❌ 错误：未检测到 Node.js！请先安装 Node.js (>= 18.0.0)"
    exit 1
fi
echo "✅ Node.js 版本: $(node -v)"

# 2. 检查包管理器 (优先 pnpm，其次 npm)
if command -v pnpm &> /dev/null; then
    PKG_MGR="pnpm"
elif command -v npm &> /dev/null; then
    PKG_MGR="npm"
else
    echo "❌ 错误：未检测到 pnpm 或 npm，请先安装 Node.js 包管理器。"
    exit 1
fi
echo "✅ 使用包管理器: $PKG_MGR"

# 3. 安装项目依赖
echo "📦 正在安装项目依赖 (包含 canvas 和 better-sqlite3，可能需要几分钟)..."
$PKG_MGR install
if [ $? -ne 0 ]; then
    echo "❌ 依赖安装失败，请检查网络或编译环境。"
    exit 1
fi

# 4. 下载 Playwright 浏览器内核
echo "🌐 正在下载 Playwright Chromium 浏览器内核..."
npx playwright install chromium

# 5. 安装 Linux 系统底层依赖 (仅限 Linux)
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "🐧 检测到 Linux 系统，正在安装 Chromium 运行所需的系统依赖库..."
    # 判断是否有 sudo，如果没有（比如 root 用户）则直接执行
    if command -v sudo &> /dev/null; then
        sudo npx playwright install-deps chromium
    else
        npx playwright install-deps chromium
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "🍎 检测到 macOS 系统，跳过系统依赖安装。"
fi

echo "======================================"
echo "🎉 构建完成！现在你可以运行 '$PKG_MGR run app' 启动机器人了。"
echo "======================================"