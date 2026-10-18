import { createCanvas, registerFont, loadImage } from 'canvas';
import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_PATH = join(__dirname, 'menu.json');
const TEMP_DIR = resolve(__dirname, '../../../temp');
const CACHE_DIR = join(TEMP_DIR, 'cache');

// 🌟 字体配置
const FONT_PATH = resolve(__dirname, '../../../fonts/NotoSansSC-Regular.otf');
try {
  registerFont(FONT_PATH, { family: 'CustomFont' });
} catch (err) {
  console.warn('[Card] 警告：自定义字体加载失败，将回退到系统字体。');
}

const FONT_STACK = '"CustomFont", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
function setFont(ctx, style, size) {
  ctx.font = `${style} ${size}px ${FONT_STACK}`;
}

// ==========================================
// 🌟 内存缓存池
// ==========================================
let cachedDefaultConfig = null;
let cachedGroupConfigs = {};
let cachedCardFiles = null;

const DEFAULT_CONFIG_PATH = join(TEMP_DIR, 'default', 'config.yaml');
const GROUP_CONFIG_DIR = join(TEMP_DIR, 'group');
const CARD_DIR = join(TEMP_DIR, 'card');

const ensureDirs = () => {
    [TEMP_DIR, CACHE_DIR, dirname(DEFAULT_CONFIG_PATH), GROUP_CONFIG_DIR, CARD_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
};
ensureDirs();

const initDefaultConfig = () => {
    if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
        const defaultYaml = `# 全局默认帮助菜单配置\ndefault_bg: ""\noverlay_color: "rgba(0, 0, 0, 0.65)"\ntitle_color: "#ffffff"\ntext_color: "#dddddd"\ncmd_color: "#88d3ce"\n`;
        fs.writeFileSync(DEFAULT_CONFIG_PATH, defaultYaml, 'utf8');
    }
    try {
        cachedDefaultConfig = yaml.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) || {};
    } catch (e) {
        cachedDefaultConfig = {};
    }
};
initDefaultConfig();

fs.watch(DEFAULT_CONFIG_PATH, (event) => { if (event === 'change') initDefaultConfig(); });
fs.watch(GROUP_CONFIG_DIR, (event, filename) => {
    if (filename && filename.endsWith('.yaml')) delete cachedGroupConfigs[filename.replace('.yaml', '')];
});
fs.watch(CARD_DIR, (event) => { if (event === 'rename' || event === 'change') cachedCardFiles = null; });

// ==========================================
// 🌟 核心：清理缓存池（防止硬盘爆炸）
// ==========================================
function cleanCacheDir() {
    try {
        const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.png'));
        // 如果超过 100 张图片，就按时间排序，删掉最旧的
        if (files.length > 100) {
            const fileStats = files.map(f => ({
                name: f,
                time: fs.statSync(join(CACHE_DIR, f)).mtimeMs
            })).sort((a, b) => a.time - b.time);

            const deleteCount = files.length - 100;
            for (let i = 0; i < deleteCount; i++) {
                fs.unlinkSync(join(CACHE_DIR, fileStats[i].name));
            }
            console.log(`[Card] 🧹 缓存清理完毕，删除了 ${deleteCount} 张旧图片。`);
        }
    } catch (e) {
        console.error('[Card] 清理缓存失败:', e.message);
    }
}

// ==========================================
// 生成帮助卡片
// ==========================================
export async function generateHelpCard(chatId = null) {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const { version, title, footer, commands, categories } = data;

  // 🌟 核心修复 1：严格区分是群号还是私聊
  // 一般群号大于 5 位数，且 isGroup 会是 true。如果你的架构里 chatId 包含群号，就直接用
  const isGroup = chatId && String(chatId).length > 5; 
  const cacheKey = isGroup ? `group_${chatId}` : 'private';

  const CACHE_IMG_NAME = `help_card_${cacheKey}.png`;
  const CACHE_VER_NAME = `version_${cacheKey}.txt`;
  const IMG_PATH = join(CACHE_DIR, CACHE_IMG_NAME);
  const VER_PATH = join(CACHE_DIR, CACHE_VER_NAME);

  // 🌟 核心修复 2：必须图片和版本文件同时存在，且版本一致才给缓存
  let oldVer = 0;
  if (fs.existsSync(VER_PATH)) {
      oldVer = parseInt(fs.readFileSync(VER_PATH, 'utf-8').trim()) || 0;
  }

  if (version === oldVer && fs.existsSync(IMG_PATH)) {
    return IMG_PATH;
  }

  console.log(`[Card] 生成卡片 (标识: ${cacheKey})，当前版本: v${version}`);
  cleanCacheDir(); // 每次生成前检查一次容量

  // ==========================================
  // 读取配置
  // ==========================================
  let config = {
      default_bg: "",
      overlay_color: "rgba(0, 0, 0, 0.65)",
      title_color: "#ffffff",
      text_color: "#dddddd",
      cmd_color: "#88d3ce",
      ...cachedDefaultConfig
  };

  if (isGroup) {
      if (!cachedGroupConfigs[chatId]) {
          const groupConfigPath = join(GROUP_CONFIG_DIR, `${chatId}.yaml`);
          if (fs.existsSync(groupConfigPath)) {
              try {
                  cachedGroupConfigs[chatId] = yaml.parse(fs.readFileSync(groupConfigPath, 'utf8')) || {};
              } catch (e) { cachedGroupConfigs[chatId] = {}; }
          } else {
              cachedGroupConfigs[chatId] = {};
          }
      }
      config = { ...config, ...cachedGroupConfigs[chatId] };
  }

  // ==========================================
  // 查找背景图
  // ==========================================
  let bgPath = null;

  // 1. 群专属图
  if (isGroup) {
      const exts = ['.jpg', '.jpeg', '.png', '.webp'];
      for (const ext of exts) {
          const testPath = join(GROUP_CONFIG_DIR, `${chatId}${ext}`);
          if (fs.existsSync(testPath)) {
              bgPath = testPath;
              break;
          }
      }
  }

  // 2. YAML 指定图
  if (!bgPath && config.default_bg) {
      const specifiedPath = path.isAbsolute(config.default_bg) 
          ? config.default_bg 
          : resolve(TEMP_DIR, config.default_bg);
      if (fs.existsSync(specifiedPath)) bgPath = specifiedPath;
  } 
  
  // 3. 随机池
  if (!bgPath) {
      if (!cachedCardFiles) {
          cachedCardFiles = fs.readdirSync(CARD_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      }
      if (cachedCardFiles.length > 0) {
          const randomFile = cachedCardFiles[Math.floor(Math.random() * cachedCardFiles.length)];
          bgPath = join(CARD_DIR, randomFile);
      }
  }

  // ==========================================
  // 画布计算
  // ==========================================
  const CANVAS_WIDTH = 1000;
  const PADDING_X = 60;
  const PADDING_TOP = 80;
  const PADDING_BOTTOM = 60;

  let y = PADDING_TOP;
  const TITLE_HEIGHT = 50;
  let contentHeight = 0;

  for (const cat of categories) {
    contentHeight += 50;
    for (const id of cat.items) {
      if (commands[id]) contentHeight += 40;
    }
    contentHeight += 20;
  }

  const CANVAS_HEIGHT = PADDING_TOP + TITLE_HEIGHT + contentHeight + PADDING_BOTTOM;
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');

  // 绘制背景
  let bgLoaded = false;
  if (bgPath) {
      try {
          const image = await loadImage(bgPath);
          const scale = Math.max(CANVAS_WIDTH / image.width, CANVAS_HEIGHT / image.height);
          const x = (CANVAS_WIDTH / 2) - (image.width / 2) * scale;
          const bgY = (CANVAS_HEIGHT / 2) - (image.height / 2) * scale;
          ctx.drawImage(image, x, bgY, image.width * scale, image.height * scale);
          bgLoaded = true;
      } catch (e) { console.error('[Card] 背景加载失败', e); }
  }

  if (!bgLoaded) {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  // 遮罩层
  ctx.fillStyle = config.overlay_color;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // 标题
  ctx.fillStyle = config.title_color;
  setFont(ctx, 'bold', 36);
  ctx.fillText(title || '星缘机器人 · 帮助', PADDING_X, PADDING_TOP + 40);

  ctx.strokeStyle = '#ffffff33';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PADDING_X, PADDING_TOP + 55);
  ctx.lineTo(CANVAS_WIDTH - PADDING_X, PADDING_TOP + 55);
  ctx.stroke();

  y = PADDING_TOP + TITLE_HEIGHT + 20;

  // 分类与指令
  for (const cat of categories) {
    ctx.fillStyle = cat.color || config.cmd_color;
    setFont(ctx, 'bold', 26);
    // 清理 Emoji，防止出方块
    const cleanCatName = cat.name.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
    ctx.fillText(cleanCatName || cat.name, PADDING_X, y);
    y += 40;

    setFont(ctx, 'normal', 22);
    ctx.fillStyle = config.text_color;
    for (const id of cat.items) {
      const item = commands[id];
      if (item) {
        ctx.fillText(`${item.cmd}  ${item.desc}`, PADDING_X + 20, y);
        y += 40;
      }
    }
    y += 20;
  }

  // 底部
  ctx.fillStyle = '#888888';
  setFont(ctx, 'normal', 16);
  ctx.fillText(footer || '', PADDING_X, CANVAS_HEIGHT - 20);

  // 保存
  fs.writeFileSync(IMG_PATH, canvas.toBuffer('image/png'));
  fs.writeFileSync(VER_PATH, String(version));

  return IMG_PATH;
}