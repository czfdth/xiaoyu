// 浏览器端的小工具：把一串 0~1 的采样点画成 SVG 折线。
// 单独放一个无依赖模块，是为了能被 node --test 直接测（src/vitals.js 里有 fs，浏览器 import 不了）。

/**
 * @param {Array<Record<string, number>>} points 采样点（按时间正序）
 * @param {string} key 取哪个字段（sleepy / tired / ...）
 * @param {{width?:number, height?:number}} [options]
 * @returns {string} SVG path 的 d 属性；少于两个点返回空串
 */
export function seriesToPath(points, key, { width = 100, height = 34 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const w = Number(width) > 0 ? Number(width) : 100;
  const h = Number(height) > 0 ? Number(height) : 34;
  return points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const raw = Number(p?.[key]);
    const value = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    const y = h - value * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

/** 折线用的纵轴范围：始终 0~1（身体指标本来就是百分比，固定刻度才看得出变化）。 */
export function sparkBounds(points, keys = []) {
  const ys = [];
  for (const p of Array.isArray(points) ? points : []) {
    for (const key of keys) {
      const raw = p?.[key];
      // null / undefined 是"没这个字段"，不是 0：统计时跳过
      if (raw === null || raw === undefined) continue;
      const v = Number(raw);
      if (Number.isFinite(v)) ys.push(v);
    }
  }
  return { min: 0, max: 1, count: ys.length };
}
