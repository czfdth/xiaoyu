<script setup>
// 她的人形状态：半透明身体 + 悬浮数值气泡。
//
// 数据全部来自 /api/her/live 的真实字段（body.raw / drifted、mood），
// 只做呈现，不编造。0~1 的数值直接映射成百分比。
import { computed } from 'vue';

const props = defineProps({
  body: { type: Object, default: () => ({}) },     // { sleepy, tired, hungry, cold }
  drifted: { type: Object, default: () => ({}) },  // 倾向值（带 drift）
  mood: { type: Object, default: () => ({}) },
  note: { type: String, default: '' },
  updatedAgoMin: { type: Number, default: null },
});

const v = (k) => Math.max(0, Math.min(1, Number(props.body?.[k]) || 0));
const pct = (k) => Math.round(v(k) * 100);

// 气泡：位置用 SVG 坐标的百分比，跟人体图对齐
const pills = computed(() => [
  { key: 'sleepy', label: '困', value: pct('sleepy'), top: '6%', left: '50%', anchor: 'head' },
  { key: 'tired', label: '累', value: pct('tired'), top: '30%', left: '14%', anchor: 'chest' },
  { key: 'hungry', label: '饿', value: pct('hungry'), top: '58%', left: '12%', anchor: 'belly' },
  { key: 'cold', label: '冷', value: pct('cold'), top: '78%', left: '16%', anchor: 'limbs' },
]);

const moodText = computed(() => String(props.mood?.mood ?? '').trim());
</script>

<template>
  <div class="body-viz">
    <!-- 左：数值气泡 -->
    <div class="bv-pills">
      <div v-for="p in pills" :key="p.key" class="bv-pill" :title="`${p.label} ${p.value}%`">
        <span class="bv-pill-label">{{ p.label }}</span>
        <span class="bv-pill-value">{{ p.value }}<small>%</small></span>
      </div>
      <div v-if="moodText" class="bv-pill bv-pill-mood" :title="props.mood?.why || ''">
        <span class="bv-pill-label">心情</span>
        <span class="bv-pill-value bv-mood">{{ moodText }}</span>
      </div>
    </div>

    <!-- 右：半透明人体 -->
    <svg class="bv-figure" viewBox="0 0 200 420" role="img" aria-label="她的身体状态">
      <defs>
        <linearGradient id="bvSkin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ffd9e0" stop-opacity="0.95" />
          <stop offset="55%" stop-color="#ffc2cf" stop-opacity="0.85" />
          <stop offset="100%" stop-color="#ffb3c4" stop-opacity="0.8" />
        </linearGradient>
        <radialGradient id="bvGlow" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stop-color="#ff8fa8" stop-opacity="0.45" />
          <stop offset="100%" stop-color="#ff8fa8" stop-opacity="0" />
        </radialGradient>
        <filter id="bvSoft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
      </defs>

      <ellipse cx="100" cy="180" rx="86" ry="170" fill="url(#bvGlow)" />

      <g fill="url(#bvSkin)" filter="url(#bvSoft)">
        <!-- 头 -->
        <ellipse cx="100" cy="52" rx="30" ry="34" />
        <!-- 颈 -->
        <rect x="90" y="82" width="20" height="14" rx="8" />
        <!-- 胸腹 -->
        <path d="M66 96 q34 -10 68 0 q10 40 4 78 q-6 40 -12 66 q-26 8 -52 0 q-6 -26 -12 -66 q-6 -38 4 -78 z" />
        <!-- 手臂 -->
        <path d="M64 104 q-16 10 -21 44 q-5 34 -2 66 q3 14 12 12 q9 -2 8 -16 q-2 -30 2 -58 q3 -24 13 -38 z" />
        <path d="M136 104 q16 10 21 44 q5 34 2 66 q-3 14 -12 12 q-9 -2 -8 -16 q2 -30 -2 -58 q-3 -24 -13 -38 z" />
        <!-- 腿 -->
        <path d="M78 244 q-6 46 -8 84 q-2 34 6 44 q10 10 18 -2 q6 -12 4 -44 q-2 -40 2 -82 z" />
        <path d="M122 244 q6 46 8 84 q2 34 -6 44 q-10 10 -18 -2 q-6 -12 -4 -44 q2 -40 -2 -82 z" />
      </g>

      <!-- 内部：心 / 胃 / 腹，随数值微微变化 -->
      <g opacity="0.55">
        <ellipse cx="100" cy="150" rx="16" ry="14"
                 :style="{ transform: `scale(${1 + v('tired') * 0.12})`, transformOrigin: '100px 150px' }"
                 fill="#ff6f8e" opacity="0.5" />
        <ellipse cx="100" cy="196" rx="20" ry="16" fill="#ff8fa8" opacity="0.45" />
        <ellipse cx="100" cy="232" rx="18" ry="12" fill="#ff9fb4" opacity="0.4" />
      </g>
    </svg>

    <div class="bv-foot">
      <span v-if="updatedAgoMin !== null" class="muted small">
        身体数据 {{ updatedAgoMin < 0 ? '—' : updatedAgoMin + ' 分钟前' }}
      </span>
      <span v-if="note" class="muted small">{{ note }}</span>
    </div>
  </div>
</template>

<style scoped>
.body-viz {
  position: relative;
  display: grid;
  grid-template-columns: 104px 1fr;
  gap: 8px;
  align-items: start;
  padding: 6px 2px 2px;
}
.bv-pills { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
.bv-pill {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px 10px;
  border-radius: 12px;
  background: rgba(255, 214, 222, 0.55);
  border: 1px solid rgba(255, 160, 180, 0.35);
  backdrop-filter: blur(6px);
  line-height: 1.1;
}
.bv-pill-label { font-size: 11px; color: #8a5560; opacity: 0.85; }
.bv-pill-value { font-size: 17px; font-weight: 700; color: #b2354f; }
.bv-pill-value small { font-size: 10px; font-weight: 600; margin-left: 1px; }
.bv-pill-mood { background: rgba(255, 236, 214, 0.6); border-color: rgba(240, 180, 120, 0.4); }
.bv-mood { font-size: 13px; font-weight: 600; color: #a35a1e; }
.bv-figure { width: 100%; max-height: 420px; }
.bv-foot {
  grid-column: 1 / -1;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding-top: 4px;
}
</style>
