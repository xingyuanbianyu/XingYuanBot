import websocket
import json
import requests
import sys
import time
from datetime import datetime

WS_URL = "ws://127.0.0.1:3004"
BRIDGE_URL = "http://127.0.0.1:9520"

WATCH_EVENTS = {"group_increase", "group_decrease"}

def on_message(ws, message):
    try:
        data = json.loads(message)
    except:
        return

    if data.get("post_type") != "notice":
        return

    notice_type = data.get("notice_type", "")
    if notice_type not in WATCH_EVENTS:
        return

    print(f"[bridge] 捕获: {notice_type} 群:{data.get('group_id')}", flush=True)

    try:
        requests.post(BRIDGE_URL, json=data, timeout=3)
    except Exception as e:
        print(f"[bridge] 转发失败: {e}", flush=True)

def on_open(ws):
    print(f"[bridge] 已连接 {WS_URL}", flush=True)

def on_error(ws, error):
    print(f"[bridge] 错误: {error}", flush=True)

def on_close(ws, code, msg):
    print(f"[bridge] 断开, 3秒后重连...", flush=True)
    time.sleep(3)
    connect()

def connect():
    ws = websocket.WebSocketApp(
        WS_URL,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )
    ws.run_forever()

if __name__ == "__main__":
    print(f"[bridge] 启动中... 转发到 {BRIDGE_URL}", flush=True)
    connect()