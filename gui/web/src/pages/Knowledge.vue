<script setup>
import { computed, onMounted, ref } from 'vue';
import { get } from '../api.js';
import { toastError, fmtTime } from '../store.js';
import Card from '../components/Card.vue';

const data = ref(null);
const focus = ref(null);
const only = ref('');

const net = computed(() => data.value?.network ?? { nodes: [], edges: [], width: 820, height: 620 });
const nodes = computed(() => net.value.nodes ?? []);
const edges = computed(() => net.value.edges ?? []);
const nodeById = computed(() => new Map(nodes.value.map((n) => [n.id, n])));

/** 跟当前焦点相连的边/点要高亮，其它变淡。 */
function isLit(id) {
  if (!focus.value) return true;
  return id === focus.value || edges.value.some((e) =>
    (e.source === focus.value && e.target === id) || (e.target === focus.value && e.source === id));
}

function edgeLit(e) {
  if (!focus.value) return true;
  return e.source === focus.value || e.target === focus.value;
}

const facts = computed(() => {
  const list = data.value?.facts ?? [];
  return only.value ? list.filter((f) => f.predicate === only.value || f.object === only.value) : list;
});

function typeColor(type) {
  if (type === 'predicate') return '#a78bfa';
  if (type === 'person') return '#4fd1c5';
  if (type === 'group') return '#e3b341';
  return '#7c8cf8';
}
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
  <Card title="关系网络" :dim="data ? `${data.totals.nodes} 个节点 · ${data.totals.edges} 条关系` : '读取中…'" tight style="margin-bottom: 14px">
    <div v-if="!data" class="empty">读取中…</div>
    <div v-else-if="!nodes.length" class="empty">
      <span class="big-ico">🕸️</span>还没有关系——先跑 <code>node scripts/extract-facts.mjs</code>
    </div>
    <div v-else class="net-wrap">
      <svg class="net" :viewBox="`0 0 ${net.width} ${net.height}`" @mouseleave="focus = null">
        <line v-for="(e, i) in edges" :key="`e${i}`"
              :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2"
              :stroke="confColor(e.confidence)"
              :stroke-opacity="edgeLit(e) ? 0.45 : 0.06"
              :stroke-width="e.confidence >= 0.8 ? 1.3 : 0.9" />
        <g v-for="n in nodes" :key="n.id" class="node"
           :class="{ dim: !isLit(n.id) }"
           @mouseenter="focus = n.id" @click="only = only === n.id ? '' : n.id">
          <circle :cx="n.x" :cy="n.y" :r="n.r"
                  :fill="typeColor(n.type)" fill-opacity="0.18"
                  :stroke="typeColor(n.type)" stroke-width="1.4" />
          <circle :cx="n.x" :cy="n.y" :r="Math.max(2, n.r * 0.38)" :fill="typeColor(n.type)" />
          <text :x="n.x" :y="n.y - n.r - 5" class="lbl">{{ n.label }}</text>
        </g>
      </svg>
      <div class="side">
        <div class="row" style="gap: 12px; flex-wrap: wrap">
          <span class="tiny"><i class="dot" style="background:#4fd1c5" /> 人</span>
          <span class="tiny"><i class="dot" style="background:#e3b341" /> 群/号</span>
          <span class="tiny"><i class="dot" style="background:#a78bfa" /> 谓词</span>`n          <span class="tiny"><i class="dot" style="background:#7c8cf8" /> 事/物</span>
        </div>
        <div class="hint" style="margin-top: 8px">
          悬停一个点：只看它和它连着的关系；点一下：下方清单只看它。
        </div>
        <div v-if="focus && nodeById.get(focus)" class="hint" style="margin-top: 10px">
          <b style="color: var(--brand)">{{ focus }}</b>
          <div class="muted small">连着 {{ edges.filter((e) => e.source === focus || e.target === focus).length }} 条关系</div>
          <div v-for="(e, i) in edges.filter((x) => x.source === focus || x.target === focus).slice(0, 8)" :key="i" class="small dim">
            {{ e.source === focus ? `${focus} —${e.predicate}→ ${e.target}` : `${e.source} —${e.predicate}→ ${focus}` }}
          </div>
        </div>
        <div v-if="only" class="row" style="gap: 6px; margin-top: 10px">
          <span class="badge">只看：{{ only }}</span>
          <button class="btn sm ghost" @click="only = ''">清除</button>
        </div>
      </div>
    </div>
  </Card>

  <Card title="事实清单" :dim="only ? `只看「${only}」` : `${facts.length} 条`">
    <div v-if="!facts.length" class="empty">没有事实</div>
    <div v-else class="table-wrap">
      <table class="table">
        <thead><tr><th>主体</th><th>谓词</th><th>对象</th><th>置信</th><th>记录</th><th>原话</th></tr></thead>
        <tbody>
          <tr v-for="(f, i) in facts.slice(0, 200)" :key="i">
            <td class="mono">{{ f.subject }}</td>
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
    被新值顶掉的旧事实 {{ data.totals.stale }} 条（保留历史，不删）。最近几条：
    <span v-for="(s, i) in data.staleFacts" :key="i" class="muted">{{ s.predicate }}={{ s.object }}<span v-if="i < data.staleFacts.length - 1">；</span></span>
  </div>
</template>

<style scoped>
.net-wrap { display: flex; gap: 16px; flex-wrap: wrap; padding: 12px; }
.net { width: min(820px, 94vw); height: auto; flex: 1 1 520px; min-width: 320px; }
.node { cursor: pointer; transition: opacity .12s ease; }
.node.dim { opacity: .18; }
.node:hover circle { stroke-width: 2.4; }
.lbl { font-size: 10px; fill: var(--text-dim); text-anchor: middle; }
.side { flex: 1 1 220px; min-width: 200px; }
</style>
