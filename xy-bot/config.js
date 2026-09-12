import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, '../xy-data/config.yaml');

let configData = null;

function getDefaultConfig() {
  return {
    blacklist_qq: [],
    blacklist_group: [],
    whitelist_qq: [],
    whitelist_group: []
  };
}

export function loadConfig() {
  try {
    // 1. 配置文件不存在时自动创建
    if (!fs.existsSync(CONFIG_PATH)) {
      console.warn(`⚠️ 配置文件不存在，正在自动创建: ${CONFIG_PATH}`);
      
      const dir = dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const defaultConfig = getDefaultConfig();
      fs.writeFileSync(CONFIG_PATH, YAML.stringify(defaultConfig), 'utf8');
    }

    // 2. 读取并解析配置文件
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = YAML.parse(fileContents) || {};

    // 3. 统一转为字符串类型（解决黑名单拦截失效问题）
    configData = {
      blacklist_qq: (parsed.blacklist_qq || []).map(String),
      blacklist_group: (parsed.blacklist_group || []).map(String),
      whitelist_qq: (parsed.whitelist_qq || []).map(String),
      whitelist_group: (parsed.whitelist_group || []).map(String),
    };

    console.log('✅ [配置] 成功读取 config.yaml');
    return configData;

  } catch (e) {
    console.error('❌ [配置] 解析 config.yaml 失败:', e.message);
    configData = getDefaultConfig();
    return configData;
  }
}

export default loadConfig();
