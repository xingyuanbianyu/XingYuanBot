import subprocess
import sys
import time
import os
import platform
import shutil
import signal  # 【新增】用于在 Linux 无图形界面时安全自杀

# 自动获取脚本所在目录
BOT_DIR = os.path.dirname(os.path.abspath(__file__))
NODE_CMD = ["node", "app.js"]

def restart_sequence():
    print("*" * 40)
    print("  [Python] 正在执行重启序列...")
    print("*" * 40)

    log_file = os.path.join(BOT_DIR, "restart_log.txt")
    old_pid = sys.argv[1] if len(sys.argv) > 1 else None
    
    current_os = platform.system()
    is_windows = current_os == "Windows"
    is_macos = current_os == "Darwin"
    is_linux = current_os == "Linux"

    try:
        with open(log_file, "w", encoding="utf-8") as f:
            f.write("=== 启动重启序列 ===\n")
            f.write(f"旧进程 PID: {old_pid}\n")
            f.write(f"当前系统: {current_os}\n")

            # --- 第1步：杀掉旧进程 ---
            if old_pid:
                print(f"  [Python] 正在关闭旧进程 (PID: {old_pid})...")
                f.write(f"正在关闭旧进程 PID: {old_pid}...\n")
                
                if is_windows:
                    kill_cmd = ["taskkill", "/f", "/pid", old_pid]
                else:
                    kill_cmd = ["kill", "-9", old_pid]

                subprocess.run(kill_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(2)
                f.write("旧进程已清理完毕。\n")
            
            # --- 第2步：启动新窗口 ---
            print("  [Python] 准备启动新窗口...")
            f.write("正在启动新进程...\n")

            if is_windows:
                # === Windows 方案 ===
                process = subprocess.Popen(
                    NODE_CMD,
                    cwd=BOT_DIR,
                    creationflags=subprocess.CREATE_NEW_CONSOLE
                )
            
            elif is_macos:
                # === macOS 方案 ===
                script_cmd = f'cd "{BOT_DIR}" && node app.js; echo "进程已结束，按回车退出..."; read'
                launch_cmd = [
                    "osascript", "-e",
                    f'tell application "Terminal" to do script "{script_cmd}"'
                ]
                subprocess.Popen(launch_cmd)
                print("  [Python] 已呼叫 macOS 终端弹出窗口。")
                f.write("已呼叫 macOS 终端。\n")

            elif is_linux:
                # === Linux 智能检测方案 ===
                cmd_to_run = f"cd '{BOT_DIR}' && node app.js; echo '进程已结束，按回车退出...'; read"
                
                launched = False
                
                # 1. 优先检测 xterm
                if shutil.which("xterm"):
                    print("  [Python] 检测到 xterm，正在启动...")
                    f.write("检测到 xterm，正在启动。\n")
                    subprocess.Popen(["xterm", "-e", cmd_to_run])
                    launched = True
                
                # 2. 检测原生 gnome-terminal
                elif shutil.which("gnome-terminal"):
                    print("  [Python] 未检测到 xterm，回退使用原生 gnome-terminal...")
                    f.write("回退使用原生 gnome-terminal。\n")
                    subprocess.Popen(["gnome-terminal", "--", "bash", "-c", cmd_to_run])
                    launched = True

                # 3. 终极兜底：如果没有图形终端，彻底杀掉自己，在后台静默拉起新进程
                if not launched:
                    print("  [Python] 未检测到可用图形终端，将在后台静默运行。")
                    f.write("未检测到图形终端，已启动后台静默运行。\n")
                    
                    # 在后台启动 Node.js 进程
                    subprocess.Popen(
                        NODE_CMD,
                        cwd=BOT_DIR,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True  # 开启新会话，脱离当前终端
                    )
                    
                    # 核心逻辑：Python 脚本自杀，让 Node.js 成为独立的后台守护进程
                    print("  [Python] 重启指令已发送，本脚本即将退出...")
                    os.kill(os.getpid(), signal.SIGTERM)

            else:
                # 其他未知系统，保险起见在后台运行
                process = subprocess.Popen(
                    NODE_CMD,
                    cwd=BOT_DIR,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True
                )
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
