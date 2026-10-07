# API.md

## index.js 注册的函数

### random(min, max)
- **参数**: `min` (number), `max` (number)
- **返回**: number
- **说明**: 返回 min 到 max 之间的随机整数（含两端）
- **示例**: `random(1, 100)` → `42`

### isEmpty(value)
- **参数**: `value` (any)
- **返回**: boolean
- **说明**: 判断值是否为空（null / undefined / '' / [] / {} 返回 true）
- **示例**: `isEmpty([])` → `true`

### print(msg, ...args)
- **参数**: `msg` (string), `...args` (any)
- **返回**: undefined
- **说明**: 格式化输出到控制台，自动处理对象/数组
- **示例**: `print('用户:', name, '在线')`

### now()
- **参数**: 无
- **返回**: string
- **说明**: 返回当前时间字符串，格式 YYYY-MM-DD HH:mm:ss
- **示例**: `now()` → `'2026-09-19 18:00:00'`

### sleep(ms)
- **参数**: `ms` (number) — 休眠毫秒数
- **返回**: Promise
- **说明**: 异步等待指定时间
- **示例**: `await sleep(1000)`

---

## db.cjs

### db(action, options)
- **参数**:
  - `action` (string) — 操作类型：'exec' | 'query' | 'find' | 'insert' | 'update' | 'delete'
  - `options` (object) — 操作参数
- **返回**: { success: boolean, data?: any, error?: string, ... }

**exec** — 执行原生 SQL
- **示例**: `db('exec', { sql: 'CREATE TABLE IF NOT EXISTS test (id INTEGER)' })`

**query** — 查询多行
- **示例**: `db('query', { sql: 'SELECT * FROM users', params: [] })`

**find** — 查询单行
- **示例**: `db('find', { sql: 'SELECT * FROM users WHERE id = ?', params: [1] })`

**insert** — 插入数据
- **示例**: `db('insert', { table: 'users', data: { name: '星愿', level: 5 } })`

**update** — 更新数据
- **示例**: `db('update', { table: 'users', data: { level: 6 }, where: 'id = ?', params: [1] })`

**delete** — 删除数据
- **示例**: `db('delete', { table: 'users', where: 'id = ?', params: [1] })`

---

## http.cjs

### httpRequest(options)
- **参数**:
  - `url` (string) — 请求地址
  - `method` (string) — 'GET' | 'POST' | 'PUT' | 'DELETE'，默认 'GET'
  - `headers` (object) — 请求头
  - `body` (any) — 请求体（对象自动 JSON 序列化）
  - `timeout` (number) — 超时毫秒，默认 10000
- **返回**: Promise → { status: number, data: any }

### httpGet(url, options)
- **参数**: `url` (string), `options` (object)
- **返回**: Promise → { status: number, data: any }

### httpPost(url, body, options)
- **参数**: `url` (string), `body` (any), `options` (object)
- **返回**: Promise → { status: number, data: any }

---

## log.js

### writeLog(module, message)
- **参数**: `module` (string) — 模块名, `message` (string) — 日志内容
- **说明**: 追加日志到 logs/{module}/{YYYY-MM-DD}.log
- **示例**: `writeLog('ws_server', '客户端接入: 127.0.0.1')`

### clearLog(module, days)
- **参数**: `module` (string) — 模块名（不传则清理所有）, `days` (number) — 保留天数（默认30）
- **说明**: 清理过期日志文件
- **示例**: `clearLog('ws_server', 7)` 或 `clearLog()`

---

## ws_server.js

### wsStartServer(options)
- **参数**: { port: number, host: string }
- **返回**: WebSocket.Server 实例
- **说明**: 启动 WebSocket 服务器

### wsRegister(methodName, handler)
- **参数**: `methodName` (string), `handler` (function)
- **handler 签名**: `(data, ws) => result` (支持 async)
- **返回**: boolean
- **说明**: 注册一个 RPC 方法

### wsUnregister(methodName)
- **参数**: `methodName` (string)
- **返回**: boolean
- **说明**: 注销方法

### wsBroadcast(method, data)
- **参数**: `method` (string), `data` (object)
- **返回**: number — 成功发送的客户端数量
- **说明**: 向所有在线客户端广播

### wsStopServer()
- **返回**: boolean
- **说明**: 停止服务器

### wsGetOnlineCount()
- **返回**: number — 在线客户端数
- **说明**: 获取当前在线客户端数量

---

## ws_client.js

### wsClientConnect(options)
- **参数**: { url: string, reconnect: boolean, reconnectDelay: number, timeout: number }
- **返回**: Promise → WebSocket 实例
- **说明**: 连接到服务端（默认开启自动重连）

### wsClientCall(method, data, options)
- **参数**: `method` (string), `data` (object), { timeout: number }
- **返回**: Promise → result
- **说明**: 调用远程方法

### wsClientOn(eventName, handler)
- **参数**: `eventName` (string), `handler` (function)
- **返回**: boolean
- **说明**: 监听广播事件（'*' 监听全部）

### wsClientOff(eventName, handler)
- **参数**: `eventName` (string), `handler` (function, 可选)
- **返回**: boolean
- **说明**: 取消监听（不传 handler 则移除该事件所有监听）

### wsClientDisconnect()
- **参数**: 无
- **说明**: 断开连接，停止自动重连

### wsClientStatus()
- **参数**: 无
- **返回**: { connected: boolean, state: string, url: string, pendingCalls: number }
- **说明**: 返回当前连接状态

---

## message.mjs

### parseMessage(rawMessage)
- **参数**: `rawMessage` (any) — 原始消息
- **返回**: object — 解析后的消息对象
- **说明**: 解析 incoming 消息（具体字段以实际实现为准）
- **示例**: 待补充

---

## msg.js

> 待补充
