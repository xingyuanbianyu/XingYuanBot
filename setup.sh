#!/bin/bash

# 获取当前脚本所在目录并进入
cd "$(dirname "$0")"

echo "======================================"
echo "🚀 开始构建 XingYuanBot 运行环境"
echo "======================================"

# 1. 检查 Node.js 环境及版本
if ! command -v node &> /dev/null; then
    echo "❌ 错误：未检测到 Node.js！请先安装 Node.js (>= 18.0.0)"
    exit 1
fi
NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ 错误：当前 Node.js 版本为 $(node -v)，XingYuanBot 要求 >= v18.0.0"
    exit 1
fi
echo "✅ Node.js 版本: $(node -v)"

# 1.1 检查 Python 环境 (因为 package.json 里有 python 依赖)
if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
    echo "⚠️  警告：未检测到 Python！如果你使用了 python 脚本插件，请安装 Python >= 3.0"
else
    echo "✅ 检测到 Python 环境"
fi

# 2. 检查包管理器 (优先 pnpm)
if command -v pnpm &> /dev/null; then
    PKG_MGR="pnpm"
elif command -v npm &> /dev/null; then
    PKG_MGR="npm"
else
    echo "❌ 错误：未检测到 pnpm 或 npm，请先安装 Node.js 包管理器。"
    exit 1
fi
echo "✅ 使用包管理器: $PKG_MGR"

# 3. Linux 编译环境前置检查 (针对 better-sqlite3 和 canvas)
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "🐧 检测到 Linux 系统，检查 C++ 编译工具链..."
    if ! command -v gcc &> /dev/null || ! command -v make &> /dev/null || ! command -v python3 &> /dev/null; then
        echo "⚠️  警告：缺少 gcc, make 或 python3，安装 better-sqlite3 和 canvas 时可能编译失败。"
        echo "💡 建议提前运行: sudo apt install -y build-essential python3"
    else
        echo "✅ C++ 编译环境就绪"
    fi
fi

# 4. 安装项目依赖
echo "📦 正在安装项目依赖 (包含 canvas 和 better-sqlite3，可能需要几分钟)..."
$PKG_MGR install
if [ $? -ne 0 ]; then
    echo "❌ 依赖安装失败，请检查网络或上述编译环境提示。"
    exit 1
fi

# 5. 下载 Playwright 浏览器内核
echo "🌐 正在下载 Playwright Chromium 浏览器内核..."
npx playwright install chromium

# 6. 安装 Linux 系统底层依赖
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "🐧 正在安装 Chromium 及 Canvas 运行所需的系统依赖库..."
    if command -v sudo &> /dev/null; then
        sudo npx playwright install-deps chromium
        # Canvas 库在部分系统上需要手动补充
        sudo apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev 2>/dev/null || true
    else
        npx playwright install-deps chromium
        apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev 2>/dev/null || true
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "🍎 检测到 macOS 系统，跳过系统依赖安装。"
fi

# 7. 检查 PM2 (生产环境常驻推荐)
if ! command -v pm2 &> /dev/null; then
    echo "💡 提示：未安装 PM2。对于云挂机项目，强烈建议使用 PM2 守护进程。"
    echo "   安装命令: npm install -g pm2"
    echo "   启动命令: pm2 start app.js --name \"XingYuanBot\""
fi

echo "======================================"
echo "🎉 构建完成！"
echo "▶ 开发测试启动: $PKG_MGR run app"
echo "▶ 生产环境启动: pm2 start app.js --name XingYuanBot"
echo "======================================"