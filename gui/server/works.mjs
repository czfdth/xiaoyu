// 作品集：图库/语音的文件清单与安全读取。
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../../src/paths.js';

const IMAGES = path.join(APP_ROOT, 'images');
const AUDIO = path.join(APP_ROOT, 'audio');
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac|silk|amr)$/i;

function listFiles(dir, re, { limit = 60, offset = 0 } = {}) {
  try {
    const all = fs.readdirSync(dir).filter((name) => re.test(name)).map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, at: stat.mtimeMs };
    }).sort((a, b) => (b.size - a.size) || (b.at - a.at));
    return { total: all.length, files: all.slice(offset, offset + Math.max(0, Math.min(200, limit || 60))) };
  } catch { return { total: 0, files: [] }; }
}

export function listImages(opts) { return listFiles(IMAGES, IMAGE_RE, opts); }
export function listAudio(opts) { return listFiles(AUDIO, AUDIO_RE, opts); }

const PORTRAIT_ORDER = ['害羞-05', '工作-04', '开心-06', '得意-01', '卖萌-03'];
const MOOD_PREFIX = {
  高兴: '开心', 开心: '开心', 得意: '得意', 害羞: '害羞',
  有点闷: '委屈', 空落落: '委屈', 难过: '难过',
  别扭: '生气', 生气: '生气', 有点气: '生气',
  困: '睡觉', 累: '睡觉', 饿: '吃饭', 想吃: '吃饭',
  好奇: '疑惑', 安静: '工作', 平静: '工作',
};

function names() {
  try { return fs.readdirSync(IMAGES).filter((n) => IMAGE_RE.test(n)); } catch { return []; }
}

/** 她本人（鲸鱼娘）的立绘。 */
export function portraitImage() {
  const all = names();
  for (const key of PORTRAIT_ORDER) {
    const hit = all.find((n) => n.includes(key));
    if (hit) return { name: hit };
  }
  const whale = all.find((n) => n.includes('鲸鱼娘'));
  return { name: whale || all[0] || '' };
}

/** 按心情挑一张她的表情图；没有就退回立绘。 */
export function emotionImage(mood) {
  const prefix = MOOD_PREFIX[String(mood || '').trim()] || '';
  const all = names();
  if (prefix) {
    const hit = all.filter((n) => n.startsWith(prefix + '-')).sort((a, b) => b.localeCompare(a))[0];
    if (hit) return { name: hit, kind: prefix };
  }
  const portrait = portraitImage();
  return { name: portrait.name, kind: 'portrait' };
}

/** 面板装饰：优先她自己的手绘（sketch-*），不够再用小尺寸图片。 */
export function decorImages({ limit = 4 } = {}) {
  try {
    const all = fs.readdirSync(IMAGES).filter((name) => IMAGE_RE.test(name)).map((name) => {
      const stat = fs.statSync(path.join(IMAGES, name));
      return { name, size: stat.size, at: stat.mtimeMs };
    });
    const sketches = all.filter((f) => /^sketch-/i.test(f.name) && f.size < 1_500_000)
      .sort((a, b) => b.at - a.at);
    const rest = all.filter((f) => !/^sketch-/i.test(f.name) && /\.(png|jpe?g|webp)$/i.test(f.name) && f.size < 400_000)
      .sort((a, b) => b.at - a.at);
    return { files: [...sketches, ...rest].slice(0, Math.max(1, Math.min(8, limit))) };
  } catch { return { files: [] }; }
}

function safePath(dir, name) {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== String(name).replace(/\\/g, '')) return '';
  const full = path.join(dir, safe);
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : '';
}

export function imagePath(name) {
  const full = safePath(IMAGES, name);
  if (!full) { const error = new Error('图片不存在'); error.statusCode = 404; throw error; }
  const ext = path.extname(full).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
  return { file: full, type };
}

export function audioPath(name) {
  const full = safePath(AUDIO, name);
  if (!full) { const error = new Error('语音不存在'); error.statusCode = 404; throw error; }
  return { file: full };
}
