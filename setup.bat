@echo off
chcp 65001 >nul
title XingYuanBot 环境构建脚本

echo ======================================
echo 🚀 开始构建 XingYuanBot 运行环境
echo ======================================

:: 1. 检查 Node.js 并校验版本 (>= 18)
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 错误：未检测到 Node.js！请先安装 Node.js ^(^>= 18.0.0^)
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_VER=%%a
:: 去掉版本号前面的 v
set NODE_VER=%NODE_VER:v=%
if %NODE_VER% LSS 18 (
    echo ❌ 错误：当前 Node.js 版本过低！XingYuanBot 要求 >= v18.0.0
    echo    请前往 https://nodejs.org/ 下载最新 LTS 版本。
    pause
    exit /b 1
)
echo ✅ Node.js 版本校验通过

:: 1.1 检查 Python 环境 (node-gyp 编译需要)
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo ⚠️  警告：未检测到 Python！
    echo    安装 canvas 和 better-sqlite3 时如果报错，请安装 Python 并勾选 "Add to PATH"。
) else (
    echo ✅ 检测到 Python 环境
)

:: 2. 检查并使用 pnpm 或 npm
where pnpm >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ 使用 pnpm 安装依赖...
    call pnpm install
) else (
    echo ✅ 使用 npm 安装依赖...
    call npm install
)

if %errorlevel% neq 0 (
    echo.
    echo ❌ 依赖安装失败！
    echo 💡 如果报错包含 "gyp ERR!" 或 "MSBuild"，说明你的 Windows 缺少 C++ 编译环境。
    echo    请以管理员身份运行 PowerShell，执行以下命令安装编译工具：
    echo    npm install --global windows-build-tools
    echo    (或者安装 Visual Studio Community 并勾选 "使用 C++ 的桌面开发")
    pause
    exit /b 1
)

:: 3. 下载 Playwright 浏览器内核
echo 🌐 正在下载 Playwright Chromium 浏览器内核...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo ❌ 浏览器内核下载失败，请检查网络。
    pause
    exit /b 1
)

echo ======================================
echo 🎉 构建完成！
echo.
echo ▶ 现在你可以运行 "npm run app" 或 "pnpm run app" 启动机器人了。
echo 💡 提示：Windows 下为了长期稳定挂机，建议使用 pm2 守护进程：
echo    npm install -g pm2
echo    pm2 start app.js --name "XingYuanBot"
echo ======================================
pause