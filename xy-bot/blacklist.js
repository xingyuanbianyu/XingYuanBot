// xy-bot/blacklist.js
// ✅ 黑白名单管理器（与 config.js 联动）

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

import { reloadConfig, getConfig } from './config.js';

// ========================
// 路径定位（与 config.js 一致）
// ========================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'xy-data', 'config.yaml');

// ========================
// 内部读写
// ========================
function readFileConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (e) {
    console.error('❌ [名单] 配置文件解析失败:', e.message);
    return {};
  }
}

function writeFileConfig(data) {
  fs.writeFileSync(CONFIG_PATH, YAML.stringify(data), 'utf8');
}

// ========================
// 校验目标是否合法（纯数字）
// ========================
function isValidTarget(target) {
  return /^\d+$/.test(String(target).trim());
}

// ========================
// 通用名单管理
// @param {string} listType   - 'qq' | 'group'
// @param {string} listKind   - 'black' | 'white'
// @param {string} target     - 目标号码
// @param {boolean} isAdd     - true 添加，false 移除
// @returns {{ok: boolean, msg: string}}
// ========================
export function manageList(listType, listKind, target, isAdd) {
  // --- 参数校验 ---
  if (!['qq', 'group'].includes(listType)) {
    return { ok: false, msg: `❌ 未知的目标类型: ${listType}（应为 qq 或 group）` };
  }
  if (!['black', 'white'].includes(listKind)) {
    return { ok: false, msg: `❌ 未知的名单类型: ${listKind}（应为 black 或 white）` };
  }
  if (!isValidTarget(target)) {
    return { ok: false, msg: `❌ 目标 ${target} 不是合法的数字 ID` };
  }

  const key = `${listKind}list_${listType}`; // blacklist_qq / whitelist_group / ...
  const label = listType === 'qq' ? 'QQ' : '群';
  const kindLabel = listKind === 'black' ? '黑名单' : '白名单';

  // --- 读取文件 ---
  const config = readFileConfig();
  if (!Array.isArray(config[key])) config[key] = [];

  // --- 统一按 String 比对（与 config.js 的 getConfig 保持一致）---
  const targetStr = String(target).trim();
  const index = config[key].indexOf(targetStr);

  if (isAdd) {
    if (index !== -1) {
      return { ok: false, msg: `❌ 该${label} ${target} 已在${kindLabel}中。` };
    }
    config[key].push(targetStr);
  } else {
    if (index === -1) {
      return { ok: false, msg: `❌ 该${label} ${target} 不在${kindLabel}中。` };
    }
    config[key].splice(index, 1);
  }

  // --- 写回文件 ---
  try {
    writeFileConfig(config);
  } catch (e) {
    return { ok: false, msg: `❌ 写入配置失败: ${e.message}` };
  }

  // 🌟 关键：刷新内存缓存，让 isQQAllowed / isGroupAllowed 立即生效
  reloadConfig();

  return {
    ok: true,
    msg: `✅ 成功将 ${target} ${isAdd ? '加入' : '移出'}${kindLabel}。`,
  };
}

// ========================
// 便捷封装：黑名单
// ========================
export function manageBlacklist(listType, target, isAdd) {
  const r = manageList(listType, 'black', target, isAdd);
  return r.msg; // 兼容旧接口：返回纯字符串
}

// ========================
// 便捷封装：白名单
// ========================
export function manageWhitelist(listType, target, isAdd) {
  const r = manageList(listType, 'white', target, isAdd);
  return r.msg;
}

// ========================
// 查看当前名单内容
// ========================
export function getList(listType, listKind) {
  const cfg = getConfig();
  const key = `${listKind}list_${listType}`;
  return Array.isArray(cfg[key]) ? [...cfg[key]] : [];
}