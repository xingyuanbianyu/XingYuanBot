import subprocess
import sys
import time
import os
import platform
import shutil
import signal

# 自动获取脚本所在目录
BOT_DIR = os.path.dirname(os.path.abspath(__file__))

# 🌟 优化 1：自动探测 node 路径
NODE_BIN = shutil.which("node") or "node"
NODE_CMD = [NODE_BIN, "--no-warnings", "app.js"]

def restart_sequence():
    print("*" * 40)
    print("  [Python] 正在执行重启序列...")
    print("*" * 40)

    log_file = os.path.join(BOT_DIR, "restart_log.txt")
    
    DAEMON_MODE = ("-d" in sys.argv or "--daemon" in sys.argv)
    pid_args = [arg for arg in sys.argv[1:] if arg not in ["-d", "--daemon"]]
    old_pid = pid_args[0] if len(pid_args) > 0 else None

    current_os = platform.system()
    is_windows = current_os == "Windows"
    is_macos = current_os == "Darwin"
    is_linux = current_os == "Linux"

    # 🌟 优化 2：如果没有传入 PID，尝试自动寻找占用端口 (以 3001 为例)
    if not old_pid and is_linux:
        try:
            # 尝试通过 lsof 寻找占用 3001 端口的进程
            out = subprocess.check_output(["lsof", "-t", "-i:3001"], stderr=subprocess.DEVNULL).decode().strip()
            if out:
                old_pid = out.split('\n')[0]
                print(f"  [Python] 未提供 PID，自动检测到占用 3001 端口的旧进程: {old_pid}")
        except Exception:
            pass

    try:
        with open(log_file, "w", encoding="utf-8") as f:
            f.write("=== 启动重启序列 ===\n")
            f.write(f"旧进程 PID: {old_pid}\n")
            f.write(f"当前系统: {current_os}\n")
            f.write(f"Node 执行路径: {NODE_BIN}\n")

            # --- 第1步：优雅杀掉旧进程 ---
            if old_pid:
                print(f"  [Python] 正在通知旧进程 (PID: {old_pid}) 优雅退出...")
                f.write(f"正在通知旧进程 PID: {old_pid} 优雅退出...\n")

                try:
                    if is_windows:
                        subprocess.run(["taskkill", "/pid", old_pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    else:
                        # Linux/Mac 发送 SIGTERM，让 Node.js 触发 cleanupAllInstances
                        subprocess.run(["kill", "-15", old_pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception as e:
                    f.write(f"发送优雅退出信号失败: {e}\n")

                # 等待 3 秒
                for _ in range(3):
                    time.sleep(1)
                    try:
                        if not is_windows:
                            os.kill(int(old_pid), 0) 
                        else:
                            # Windows 下简单用 tasklist 查一下
                            check = subprocess.run(["tasklist", "/FI", f"PID eq {old_pid}"], capture_output=True, text=True)
                            if old_pid not in check.stdout:
                                raise OSError("进程已消失")
                    except OSError:
                        print(f"  [Python] 旧进程已优雅退出。")
                        f.write("旧进程已优雅退出。\n")
                        break
                else:
                    print(f"  [Python] 旧进程未响应，执行强制击杀...")
                    f.write("旧进程未响应，执行强制击杀。\n")
                    if is_windows:
                        subprocess.run(["taskkill", "/f", "/pid", old_pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    else:
                        subprocess.run(["kill", "-9", old_pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    time.sleep(1)

            # --- 第2步：启动新窗口 ---
            print("  [Python] 准备启动新窗口...")
            f.write("正在启动新进程...\n")
            
            # 🌟 优化 3：日志防膨胀机制
            daemon_log = os.path.join(BOT_DIR, "bot_daemon.log")
            if os.path.exists(daemon_log) and os.path.getsize(daemon_log) > 10 * 1024 * 1024: # 10MB
                try:
                    os.rename(daemon_log, daemon_log + ".old")
                except:
                    pass

            if is_windows:
                subprocess.Popen(NODE_CMD, cwd=BOT_DIR, creationflags=subprocess.CREATE_NEW_CONSOLE)

            elif is_macos:
                # Mac 下使用 osascript 调起 Terminal
                script_cmd = f"cd '{BOT_DIR}' && {NODE_BIN} app.js; echo '进程已结束，按回车退出...'; read"
                launch_cmd = ["osascript", "-e", f'tell application "Terminal" to do script "{script_cmd}"']
                subprocess.Popen(launch_cmd)
                print("  [Python] 已呼叫 macOS 终端弹出窗口。")
                f.write("已呼叫 macOS 终端。\n")

            elif is_linux:
                cmd_to_run = f"cd '{BOT_DIR}' && {NODE_BIN} app.js; echo '进程已结束，按回车退出...'; read"
                launched = False

                if DAEMON_MODE:
                    print(f"  [Python] 正在启动后台守护进程 (日志: {daemon_log})...")
                    f.write("启动 Linux 后台守护进程...\n")
                    with open(daemon_log, "a") as dlog:
                        # 🌟 使用 start_new_session 让子进程脱离父进程，防止 SIGHUP 挂断
                        subprocess.Popen(NODE_CMD, cwd=BOT_DIR, stdout=dlog, stderr=subprocess.STDOUT, start_new_session=True)
                    launched = True
                else:
                    # 🌟 优化 4：增加更多终端兼容
                    terminals = [
                        ("xterm", ["xterm", "-e", cmd_to_run]),
                        ("gnome-terminal", ["gnome-terminal", "--", "bash", "-c", cmd_to_run]),
                        ("konsole", ["konsole", "-e", "bash", "-c", cmd_to_run]),
                        ("xfce4-terminal", ["xfce4-terminal", "-e", cmd_to_run])
                    ]
                    
                    for term_name, term_cmd in terminals:
                        if shutil.which(term_name):
                            print(f"  [Python] 检测到 {term_name}，正在启动...")
                            f.write(f"检测到 {term_name}，正在启动。\n")
                            subprocess.Popen(term_cmd)
                            launched = True
                            break

                    if not launched:
                        print("  [Python] 未检测到可用图形终端，将在后台静默运行。")
                        f.write("未检测到图形终端，已启动后台静默运行。\n")
                        with open(daemon_log, "a") as dlog:
                            subprocess.Popen(NODE_CMD, cwd=BOT_DIR, stdout=dlog, stderr=subprocess.STDOUT, start_new_session=True)
                        
                        # 让 Python 脚本立刻退出，把空间留给 Node.js
                        print("  [Python] 重启指令已发送，本脚本即将退出...")
                        os._exit(0) # 使用 _exit 立刻退出，防止清理逻辑挂断子进程

            else:
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