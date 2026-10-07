import subprocess
import sys
import time
import os
import platform
import shutil
import signal

# 自动获取脚本所在目录
BOT_DIR = os.path.dirname(os.path.abspath(__file__))
NODE_CMD = ["node", "--no-warnings", "app.js"]

# Windows 后台静默运行的标志位
CREATE_NO_WINDOW = 0x08000000

def restart_sequence():
    print("*" * 40)
    print("  [Python] 正在执行重启序列...")
    print("*" * 40)

    log_file = os.path.join(BOT_DIR, "restart_log.txt")
    
    # 1. 解析参数
    DAEMON_MODE = ("-d" in sys.argv or "--daemon" in sys.argv)
    
    # 提取旧进程 PID（过滤掉 -d/--daemon 参数）
    pid_args = [arg for arg in sys.argv[1:] if arg not in ["-d", "--daemon"]]
    old_pid = pid_args[0] if len(pid_args) > 0 else None

    current_os = platform.system()
    is_windows = current_os == "Windows"
    is_macos = current_os == "Darwin"
    is_linux = current_os == "Linux"

    # 🌟 核心新增：自检 PM2 环境
    # 只要是 PM2 拉起的进程，环境变量里一定会有 pm_id 或 PM2_HOME
    is_pm2_mode = os.environ.get('pm_id') is not None or os.environ.get('PM2_HOME') is not None

    try:
        with open(log_file, "w", encoding="utf-8") as f:
            f.write("=== 启动重启序列 ===\n")
            f.write(f"旧进程 PID: {old_pid}\n")
            f.write(f"当前系统: {current_os}\n")
            f.write(f"PM2 托管模式: {is_pm2_mode}\n")
            f.write(f"启动模式: {'后台守护模式 (Daemon)' if DAEMON_MODE else '前台窗口模式'}\n")

            # --- 第1步：杀掉旧进程 ---
            if old_pid:
                print(f"  [Python] 正在关闭旧进程 (PID: {old_pid})...")
                f.write(f"正在关闭旧进程 PID: {old_pid}...\n")

                if is_windows:
                    kill_cmd = ["taskkill", "/f", "/pid", old_pid]
                else:
                    kill_cmd = ["kill", "-9", old_pid]

                subprocess.run(kill_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print("  [Python] 等待旧进程端口释放...")
                time.sleep(3) # 释放端口给一点缓冲时间
                f.write("旧进程已清理，端口已释放。\n")

            # 🌟 核心新增：如果是 PM2 模式，杀完旧进程直接退出，让 PM2 接管
            if is_pm2_mode:
                print("  [Python] 检测到 PM2 托管，旧进程已杀，本脚本即将退出。")
                print("  [Python] PM2 将在检测到旧进程断开后，自动拉起新的 Node 进程。")
                f.write("PM2 模式：Python 脚本已退出，等待 PM2 自动拉起 Node。\n")
                time.sleep(1)
                sys.exit(0)

            # --- 第2步：非 PM2 模式，启动新进程 ---
            print("  [Python] 准备启动新进程...")
            f.write("正在启动新进程...\n")

            if is_windows:
                # === Windows 方案 ===
                if DAEMON_MODE:
                    print("  [Python] 正在后台静默启动 Node.js...")
                    f.write("Windows 后台静默启动。\n")
                    subprocess.Popen(
                        NODE_CMD,
                        cwd=BOT_DIR,
                        creationflags=CREATE_NO_WINDOW,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL
                    )
                else:
                    print("  [Python] 正在新窗口中启动 Node.js...")
                    f.write("Windows 新窗口启动。\n")
                    subprocess.Popen(
                        NODE_CMD,
                        cwd=BOT_DIR,
                        creationflags=subprocess.CREATE_NEW_CONSOLE
                    )

            elif is_macos:
                # === macOS 方案 ===
                script_cmd = f"cd '{BOT_DIR}' && node app.js; echo '进程已结束，按回车退出...'; read"
                launch_cmd = ["osascript", "-e", f'tell application "Terminal" to do script "{script_cmd}"']
                subprocess.Popen(launch_cmd)
                print("  [Python] 已呼叫 macOS 终端弹出窗口。")
                f.write("已呼叫 macOS 终端。\n")

            elif is_linux:
                # === Linux 方案 ===
                cmd_to_run = f"cd '{BOT_DIR}' && node app.js; echo '进程已结束，按回车退出...'; read"
                launched = False

                if DAEMON_MODE:
                    daemon_log = os.path.join(BOT_DIR, "bot_daemon.log")
                    print(f"  [Python] 正在启动后台守护进程 (日志: {daemon_log})...")
                    f.write("启动 Linux 后台守护进程...\n")
                    with open(daemon_log, "a") as dlog:
                        subprocess.Popen(
                            NODE_CMD,
                            cwd=BOT_DIR,
                            stdout=dlog,
                            stderr=subprocess.STDOUT,
                            start_new_session=True
                        )
                    launched = True
                else:
                    if shutil.which("xterm"):
                        subprocess.Popen(["xterm", "-e", cmd_to_run])
                        launched = True
                    elif shutil.which("gnome-terminal"):
                        subprocess.Popen(["gnome-terminal", "--", "bash", "-c", cmd_to_run])
                        launched = True

                    if not launched:
                        print("  [Python] 未检测到可用图形终端，将在后台静默运行。")
                        f.write("未检测到图形终端，已启动后台静默运行。\n")
                        daemon_log = os.path.join(BOT_DIR, "bot_daemon.log")
                        with open(daemon_log, "a") as dlog:
                            subprocess.Popen(
                                NODE_CMD,
                                cwd=BOT_DIR,
                                stdout=dlog,
                                stderr=subprocess.STDOUT,
                                start_new_session=True
                            )
                        print("  [Python] 重启指令已发送，本脚本即将退出...")
                        os.kill(os.getpid(), signal.SIGTERM)

            else:
                # 其他未知系统，保险起见在后台运行
                subprocess.Popen(NODE_CMD, cwd=BOT_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                f.write("未知系统，已在后台运行。\n")

            print("*" * 40)
            print("  [Python] 重启指令已发送！")
            print("  [Python] 本脚本将在 3 秒后自动消失...")
            print("*" * 40)

            time.sleep(3)
            sys.exit(0)

    except Exception as e:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"[错误] {str(e)}\n")
        print(f"[错误] 发生异常: {e}")
        input("按回车键退出...")

if __name__ == "__main__":
    restart_sequence()