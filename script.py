import subprocess
import sys
import time
import os
import platform

# 获取脚本所在目录
BOT_DIR = os.path.dirname(os.path.abspath(__file__))

def main():
    # 1. 获取要杀掉的旧进程 PID
    pid_args = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    old_pid = pid_args[0] if len(pid_args) > 0 else None

    # 2. 检测是否在 PM2 环境下运行 (PM2 会注入 pm_id 环境变量)
    is_pm2 = "pm_id" in os.environ or "PM2_HOME" in os.environ

    # 3. 杀掉旧进程
    if old_pid:
        print(f"[重启] 正在清理旧进程 (PID: {old_pid})...")
        try:
            if platform.system() == "Windows":
                subprocess.run(["taskkill", "/f", "/pid", old_pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.run(["kill", "-15", old_pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(1)
                subprocess.run(["kill", "-9", old_pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            print(f"[重启] 杀进程失败: {e}")

    # 4. 根据环境决定是否自己启动
    if is_pm2:
        print("[重启] 检测到 PM2 守护，已交由 PM2 自动拉起新进程。")
        sys.exit(0) # 直接退出，不管了
    else:
        print("[重启] 未检测到 PM2，正在后台重新拉起 Node...")
        # 没有任何 PM 守护，自己拉起一个后台进程
        try:
            subprocess.Popen(
                ["node", "--no-warnings", "app.js"], 
                cwd=BOT_DIR, 
                stdout=subprocess.DEVNULL, 
                stderr=subprocess.DEVNULL,
                start_new_session=True # 脱离当前会话，防止被连带杀掉
            )
        except Exception as e:
            print(f"[重启] 拉起进程失败: {e}")

if __name__ == "__main__":
    main()