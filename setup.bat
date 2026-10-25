@echo off
chcp 65001 >nul
title XingYuanBot 环境构建脚本

echo ======================================
echo 🚀 开始构建 XingYuanBot 运行环境
echo ======================================

:: 1. 检查 Node.js
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 错误：未检测到 Node.js！请先安装 Node.js ^(^>= 18.0.0^)
    pause
    exit /b 1
)
echo ✅ Node.js 已安装

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
    echo ❌ 依赖安装失败，请检查网络或编译环境。
    pause
    exit /b 1
)

:: 3. 下载 Playwright 浏览器内核
echo 🌐 正在下载 Playwright Chromium 浏览器内核...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo ❌ 浏览器内核下载失败。
    pause
    exit /b 1
)

echo ======================================
echo 🎉 构建完成！现在你可以运行 "npm run app" 或 "pnpm run app" 启动机器人了。
echo ======================================
pause