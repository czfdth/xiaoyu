// 外面的世界：给她一点"今天天气怎么样"这类真实环境信息。
//
// 边界（重要）：只放**真实可核验**的量（气温、天气、季节、周几），绝不编造。
// 天气从 open-meteo 拉（免密钥），缓存 1 小时；拉不到就不说话，不猜。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { readConfig } from './paths.js';

const CACHE = path.join(STATE_DIR, 'ambient.json');
const TTL_MS = 60 * 60 * 1000;

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch { return null; }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch { /* 写不进去就用内存里的 */ }
}

/** 上海时间的小时/周几/季节。 */
function localFacts(now) {
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', ...opts }).format(new Date(now));
  const month = Number(fmt({ month: '2-digit' }));
  const hour = Number(fmt({ hour: '2-digit', hour12: false }));
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(new Date(now));
  const season = month >= 3 && month <= 5 ? '春天'
    : month >= 6 && month <= 8 ? '夏天'
    : month >= 9 && month <= 11 ? '秋天' : '冬天';
  return { month, hour, weekday, season };
}

/** 天气描述（WMO weather code → 中文）。 */
function weatherText(code) {
  const map = {
    0: '晴', 1: '大致晴', 2: '多云', 3: '阴',
    45: '有雾', 48: '雾凇',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    71: '小雪', 73: '中雪', 75: '大雪',
    80: '阵雨', 81: '强阵雨', 82: '暴雨',
    95: '雷阵雨', 96: '雷阵雨带冰雹', 99: '强雷暴',
  };
  return map[code] ?? '';
}

/**
 * 拉一次天气并写缓存。失败就保留旧缓存（不覆盖成空）。
 * @param {{now?: number, force?: boolean}} [opts]
 */
export async function refreshWeather({ now = Date.now(), force = false } = {}) {
  const cached = readCache();
  if (!force && cached?.weatherAt && now - cached.weatherAt < TTL_MS) return cached;

  const cfg = readConfig();
  const lat = Number(cfg?.ambient?.lat ?? 43.88);   // 默认长春（她的机器所在地，可按需在 config 里改）
  const lon = Number(cfg?.ambient?.lon ?? 125.32);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + '&current=temperature_2m,weather_code,apparent_temperature&timezone=Asia%2FShanghai';
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return cached;
    const json = await res.json();
    const cur = json?.current ?? {};
    const next = {
      ...(cached ?? {}),
      weatherAt: now,
      tempC: Number(cur.temperature_2m),
      feelsC: Number(cur.apparent_temperature),
      code: Number(cur.weather_code),
      weather: weatherText(Number(cur.weather_code)),
    };
    if (!Number.isFinite(next.tempC)) return cached;
    writeCache(next);
    return next;
  } catch {
    return cached;
  }
}

/**
 * 拼一行"外面"的信息；没有可用数据就返回空串。
 * @param {{now?: number}} [opts]
 */
export function ambientLine({ now = Date.now() } = {}) {
  try {
    const { weekday, season, hour } = localFacts(now);
    const cached = readCache();
    const fresh = cached?.weatherAt && now - cached.weatherAt < 6 * 3600000;  // 6 小时内算新鲜

    const bits = [`${season}的${weekday}`];
    if (fresh && Number.isFinite(cached.tempC)) {
      const w = cached.weather ? cached.weather : '';
      bits.push(`外面 ${Math.round(cached.tempC)}°${w ? '，' + w : ''}`);
    }
    // 深夜/清晨不塞天气噪音
    if (hour < 6 || hour >= 23) bits.pop();

    if (bits.length < 2) return '';
    return `【外面】${bits.join('，')}\n（只是背景，不用刻意提。）\n\n`;
  } catch {
    return '';
  }
}
