// ======== xy-lib/fl/index.js ========
// 全局工具集：random / isEmpty / sleep / now / print
// 设计目标：脚本注入 / 控制台 / 油猴脚本，直接 random(1,10) 调用
(function () {
  "use strict";

  const VERSION = "1.0.1";
  const NS = "fl";   // 命名空间：fl.random 也可访问

  // ---------- 幂等：重复加载直接跳过 ----------
  if (globalThis[NS] && globalThis[NS].version === VERSION) {
    console.log(`ℹ️ [xy-lib] fl ${VERSION} 已加载，跳过`);
    return;
  }

  const pad = n => String(n).padStart(2, "0");

  // ---------- 1. 随机整数 [min, max] ----------
  function random(min, max) {
    min = Number(min);
    max = Number(max);
    if (Number.isNaN(min)) min = 0;
    if (Number.isNaN(max)) max = 0;
    if (min > max) [min, max] = [max, min];
    min = Math.ceil(min);
    max = Math.floor(max);
    if (min > max) {
      throw new RangeError(`random: 区间取整后无整数可取（min=${min} > max=${max}）`);
    }
    if (min === max) return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ---------- 2. 判空 ----------
  function isEmpty(val) {
    if (val === null || val === undefined) return true;
    const t = typeof val;
    if (t === "number") return Number.isNaN(val);
    if (t === "boolean" || t === "function") return false;
    if (t === "bigint" || t === "symbol") return false;
    if (t === "string") return val.trim() === "";

    if (Array.isArray(val)) return val.length === 0;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) return val.byteLength === 0;
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(val)) return val.byteLength === 0;

    if (val instanceof Date) return Number.isNaN(val.getTime());
    if (val instanceof Error) return false;
    if (val instanceof RegExp) return false;
    if (typeof Map !== "undefined" && val instanceof Map) return val.size === 0;
    if (typeof Set !== "undefined" && val instanceof Set) return val.size === 0;
    if (typeof WeakMap !== "undefined" && val instanceof WeakMap) return false;
    if (typeof WeakSet !== "undefined" && val instanceof WeakSet) return false;

    if (typeof Node !== "undefined" && val instanceof Node) return false;

    try {
      return Object.keys(val).length === 0;
    } catch {
      return false;
    }
  }

  // ---------- 3. 延时（支持取消） ----------
  // 全局工具场景：取消即 resolve，不触发 unhandledrejection；用 p.cancelled 区分
  function sleep(ms) {
    ms = Number(ms);
    if (Number.isNaN(ms) || ms < 0) ms = 0;

    let timer = null;
    let resolveFn = null;
    let settled = false;

    const promise = new Promise(resolve => {
      resolveFn = resolve;
      timer = setTimeout(() => { timer = null; settled = true; resolve(); }, ms);
    });

    promise.cancelled = false;
    promise.cancel = () => {
      if (settled) return;
      if (timer) { clearTimeout(timer); timer = null; }
      settled = true;
      promise.cancelled = true;
      resolveFn();
    };

    return promise;
  }

  // ---------- 4. 当前时间字符串（本地时区） ----------
  function now() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ---------- 5. 打印 ----------
  const print = (typeof console !== "undefined" && typeof console.log === "function")
    ? console.log.bind(console)
    : function () {};

  // ---------- 组装并挂载 ----------
  const api = { version: VERSION, random, isEmpty, sleep, now, print };

  // 双挂：fl.random 永远可用；短名 random 优先保证调用方便
  globalThis[NS] = api;

  const conflicts = [];
  for (const k of Object.keys(api)) {
    if (k === "version") continue;
    if (typeof globalThis[k] !== "undefined" && globalThis[k] !== api[k]) {
      conflicts.push(k);
    }
    globalThis[k] = api[k];
  }

  if (conflicts.length) {
    console.warn(
      `⚠️ [xy-lib] 覆盖了已有全局：${conflicts.join(", ")}\n` +
      `   如需保留原值，请改用 fl.xxx 命名空间访问本工具。`
    );
  }

  console.log(`✅ [xy-lib] fl ${VERSION} 已加载`);
})();