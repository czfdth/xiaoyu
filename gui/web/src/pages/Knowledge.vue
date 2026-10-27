<script setup>
import { computed, onMounted, ref } from 'vue';
import { get } from '../api.js';
import { toastError, fmtTime } from '../store.js';
import Card from '../components/Card.vue';

const data = ref(null);
const hover = ref(null);
const only = ref('');

const nodes = computed(() => data.value?.layout?.nodes ?? []);
const groups = computed(() => data.value?.layout?.groups ?? []);
const facts = computed(() => {
  const list = data.value?.facts ?? [];
  return only.value ? list.filter((f) => f.predicate === only.value) : list;
});
const byPredicate = computed(() => {
  const map = new Map();
  for (const f of data.value?.facts ?? []) {
    if (!map.has(f.predicate)) map.set(f.predicate, []);
    map.get(f.predicate).push(f);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
});

function confColor(c) {
  if (c >= 0.8) return 'var(--ok)';
  if (c >= 0.6) return 'var(--brand)';
  return 'var(--warn)';
}

async function load() {
  try { data.value = await get('/kg'); } catch (e) { toastError(e); }
}
onMounted(load);
</script>

<template>
  <Card title="关系图" :dim="data ? `${data.totals.facts} 条有效事实 · ${data.totals.entities} 个实体` : '读取中…'" style="margin-bottom: 14px">
    <div v-if="!data" class="empty">读取中…</div>
    <div v-else-if="!nodes.length" class="empty">
      <span class="big-ico">🕸️</span>还没有事实——先跑 <code>node scripts/extract-facts.mjs</code>
    </div>
    <div v-else class="web-wrap">
      <svg class="web" viewBox="-230 -215 460 430">
        <defs>
          <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#4fd1c5" stop-opacity=".55" />
            <stop offset="100%" stop-color="#4fd1c5" stop-opacity="0" />
          </radialGradient>
        </defs>
        <circle cx="0" cy="0" r="70" fill="url(#coreGlow)" />
        <g v-for="n in nodes" :key="`${n.predicate}:${n.object}`">
          <line :x1="0" :y1="0" :x2="n.x" :y2="n.y"
                :stroke="confColor(n.confidence)" :stroke-width="n.confidence >= 0.8 ? 1.6 : 1"
                :stroke-opacity="hover && hover !== n ? 0.15 : 0.5" />
          <circle :cx="n.x" :cy="n.y" :r="n.confidence >= 0.8 ? 5 : 3.6"
                  :fill="confColor(n.confidence)" class="node"
                  @mouseenter="hover = n" @mouseleave="hover = null" />
          <text :x="n.x * 1.18" :y="n.y * 1.18" class="lbl" :class="{ dim: hover && hover !== n }">
            {{ n.object.length > 10 ? n.object.slice(0, 10) + '…' : n.object }}
          </text>
        </g>
        <circle cx="0" cy="0" r="26" class="core" />
        <text x="0" y="5" class="core-lbl">{{ data.entities[0]?.name || '他' }}</text>
      </svg>
      <div class="legend">
        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <span class="tiny"><i class="dot" style="background: var(--ok)" /> 置信 ≥0.8</span>
          <span class="tiny"><i class="dot" style="background: var(--brand)" /> 0.6~0.8</span>
          <span class="tiny"><i class="dot" style="background: var(--warn)" /> &lt;0.6（推断）</span>
        </div>
        <div v-if="hover" class="hint" style="margin-top: 8px">
          <b>{{ hover.predicate }}</b>：{{ hover.object }}
          <span class="muted">· 置信 {{ Math.round(hover.confidence * 100) }}%<span v-if="hover.ageDays != null"> · {{ hover.ageDays }} 天前</span></span>
          <div v-if="hover.source" class="dim small">原话：{{ hover.source }}</div>
        </div>
        <div v-else class="hint" style="margin-top: 8px">把鼠标放在点上，能看到它来自哪句话。</div>
        <div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 10px">
          <button v-for="g in groups" :key="g.predicate" class="btn sm" :class="only === g.predicate ? 'primary' : 'ghost'"
                  @click="only = only === g.predicate ? '' : g.predicate">
            {{ g.predicate }} <span class="tiny">{{ g.count }}</span>
          </button>
        </div>
      </div>
    </div>
  </Card>

  <Card title="事实清单" :dim="only ? `只看「${only}」` : ``">
    <div v-if="!facts.length" class="empty">没有事实</div>
    <div v-else class="table-wrap">
      <table class="table">
        <thead><tr><th>谓词</th><th>值</th><th>置信</th><th>时间</th><th>原话</th></tr></thead>
        <tbody>
          <tr v-for="(f, i) in facts" :key="i">
            <td class="mono">{{ f.predicate }}</td>
            <td>{{ f.object }}</td>
            <td><span class="badge" :style="{ color: confColor(f.confidence) }">{{ Math.round(f.confidence * 100) }}%</span></td>
            <td class="muted small">{{ f.at ? fmtTime(f.at) : '—' }}</td>
            <td class="dim small">{{ f.source || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </Card>

  <div v-if="data?.staleFacts?.length" class="hint" style="margin-top: 10px">
    已经失效、被新值顶掉的旧事实 {{ data.totals.stale }} 条（保留历史，不删）。最近几条：
    <span v-for="(s, i) in data.staleFacts" :key="i" class="muted"> {{ s.predicate }}={{ s.object }}<span v-if="i < data.staleFacts.length - 1">；</span></span>
  </div>
</template>

<style scoped>
.web-wrap { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; }
.web { width: min(460px, 92vw); height: auto; flex: 0 0 auto; }
.node { cursor: pointer; transition: r .12s ease; }
.node:hover { r: 7; }
.lbl { font-size: 9px; fill: var(--text-dim); text-anchor: middle; dominant-baseline: middle; }
.lbl.dim { opacity: .25; }
.core { fill: #0b1118; stroke: var(--brand); stroke-width: 1.6; }
.core-lbl { fill: var(--brand); font-size: 13px; text-anchor: middle; font-weight: 650; }
.legend { flex: 1; min-width: 240px; }
</style>
