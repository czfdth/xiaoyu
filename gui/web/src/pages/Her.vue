<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { get } from '../api.js';
import { toastError, fmtClock, fmtTime, pct } from '../store.js';
import { seriesToPath } from '../lib/spark.js';
import Card from '../components/Card.vue';

const route = useRoute();

const tab = ref(route.query.tab === 'talk' || route.query.q ? 'talk' : 'state');
const her = ref(null);
const vitals = ref(null);
const days = ref([]);
const day = ref('');
const journal = ref(null);
const timeline = ref(null);
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const hits = ref([]);
const searching = ref(false);
const searched = ref(false);
const avatarSrc = ref('');

const BODY = [
  { key: 'sleepy', label: '困', icon: '😴', color: '#7c8cf8' },
  { key: 'hungry', label: '饿', icon: '🍚', color: '#ff9f6b' },
  { key: 'cold', label: '冷', icon: '🥶', color: '#58a6ff' },
  { key: 'tired', label: '累', icon: '🪫', color: '#e3b341' },
];

const INNER = [
  { key: 'doing', label: '在做', icon: '🎨' },
  { key: 'thinking', label: '在想', icon: '💭' },
  { key: 'worrying', label: '惦记', icon: '🪢' },
  { key: 'lastTopic', label: '上次说到', icon: '🗣️' },
  { key: 'curious', label: '好奇', icon: '🔍' },
  { key: 'mood', label: '心情', icon: '🌤️' },
];

/** 把 "x 分钟前 / x 小时前" 说得像人话；null 表示文件都没有。 */
function agoText(ms) {
  if (ms == null || !Number.isFinite(ms)) return '还没记过';
  const min = Math.round(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

const STALE_MS = 6 * 3600 * 1000;
const staleBits = computed(() => {
  const ages = vitals.value?.now?.ages ?? {};
  const out = [];
  if (ages.body != null && ages.body > STALE_MS) out.push('身体');
  if (ages.inner != null && ages.inner > STALE_MS) out.push('内心');
  return out;
});

const stampedAt = computed(() => {
  const ages = vitals.value?.now?.ages ?? {};
  const list = [ages.body, ages.mood, ages.inner].filter((v) => v != null && Number.isFinite(v));
  if (!list.length) return null;
  return Math.min(...list);
});

/** 24h 序列 → SVG 折线；纯画图逻辑在 src/lib/spark.js（有单测，浏览器可 import）。 */
function seriesPath(key) {
  return seriesToPath(vitals.value?.series ?? [], key);
}

function latest(key) {
  const points = vitals.value?.series ?? [];
  if (points.length) return Number(points[points.length - 1][key]) || 0;
  return Number(her.value?.body?.[key]) || 0;
}

/** 和 1 小时前的采样比：涨了/降了多少（没有历史就返回 null）。 */
function trendOf(key) {
  const points = vitals.value?.series ?? [];
  if (points.length < 2) return null;
  const now = points[points.length - 1];
  const ref = points.find((p) => p.t >= now.t - 3600 * 1000) ?? points[0];
  const delta = (Number(now[key]) || 0) - (Number(ref[key]) || 0);
  if (Math.abs(delta) < 0.05) return null;
  return { up: delta > 0, delta: Math.abs(delta) };
}

const activity = computed(() => vitals.value?.activity ?? []);
const maxBar = computed(() => Math.max(1, ...activity.value.map((b) => b.her + b.other)));
const stats = computed(() => vitals.value?.stats ?? {});
const hasSeries = computed(() => (vitals.value?.series ?? []).length >= 2);

async function loadHer() {
  try { her.value = await get('/her'); } catch (e) { toastError(e); }
}

async function loadVitals() {
  try {
    vitals.value = await get('/vitals?hours=24');
    const mood = vitals.value?.now?.mood?.mood || '';
    avatarSrc.value = `/api/works/emotion-image?mood=${encodeURIComponent(mood)}&t=${Date.now()}`;
  } catch (e) { toastError(e); }
}

async function loadDays() {
  try {
    const r = await get('/journal/days');
    days.value = r.days ?? [];
    if (!day.value) day.value = typeof route.query.day === 'string' ? route.query.day : (days.value[0] ?? new Date().toISOString().slice(0, 10));
  } catch (e) { toastError(e); }
}

async function loadJournal() {
  if (!day.value) return;
  try {
    journal.value = await get(`/journal?day=${encodeURIComponent(day.value)}`);
    await nextTick();
    if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight;
  } catch (e) { toastError(e); }
}

async function runSearch() {
  const text = q.value.trim();
  if (!text) { hits.value = []; searched.value = false; return; }
  searching.value = true;
  try {
    const r = await get(`/journal/search?q=${encodeURIComponent(text)}`);
    hits.value = r.hits ?? [];
    searched.value = true;
  } catch (e) { toastError(e); } finally { searching.value = false; }
}

async function openHit(h) {
  q.value = '';
  hits.value = [];
  searched.value = false;
  if (day.value === h.day) await loadJournal();
  else day.value = h.day;
}

function who(m) {
  if (m.role === 'her') return '她';
  return m.sender || (String(m.key).startsWith('group:') ? '群里' : '他');
}

let timer = null;
onMounted(async () => {
  if (q.value.trim()) tab.value = 'talk';
  await Promise.all([loadHer(), loadVitals(), loadDays()]);
  await loadJournal();
  if (q.value.trim()) runSearch();
  timer = setInterval(() => { if (!document.hidden && tab.value === 'state') loadVitals(); }, 60000);
});
onUnmounted(() => clearInterval(timer));

async function refreshState() {
  await Promise.all([loadHer(), loadVitals()]);
}
</script>

<template>
  <div class="tabs" style="margin-bottom: 16px">
    <div class="tab" :class="{ active: tab === 'state' }" @click="tab = 'state'">状态</div>
    <div class="tab" :class="{ active: tab === 'talk' }" @click="tab = 'talk'">对话</div>
  </div>

  <template v-if="tab === 'state'">
    <div v-if="!her" class="empty">读取中…</div>
    <template v-else>
      <!-- 头图：她此刻的样子 + 一句话状态 -->
      <Card flush style="margin-bottom: 14px">
        <div class="her-hero">
          <img v-if="avatarSrc" class="her-face" :src="avatarSrc" alt="" @error="avatarSrc = ''" />
          <div class="her-hero-body">
            <div class="row" style="gap: 10px; flex-wrap: wrap; align-items: center">
              <span class="her-mood">{{ her.mood.mood || '平静' }}</span>
              <span v-if="her.mood.why" class="dim small">{{ her.mood.why }}</span>
              <span class="badge" :class="staleBits.length ? 'warn' : 'ok'">
                状态更新于 {{ agoText(stampedAt) }}
              </span>
              <button class="btn sm ghost" style="margin-left: auto" @click="refreshState">刷新</button>
            </div>
            <div class="her-doing">{{ her.inner.doing || '没在做什么' }}</div>
            <div v-if="staleBits.length" class="hint" style="margin-top: 6px">
              {{ staleBits.join('、') }}已经超过 6 小时没更新了 —— 她下次唤醒会被提醒先更新，别把旧状态当现在。
            </div>
          </div>
        </div>
      </Card>

      <div class="grid cols-2" style="margin-bottom: 14px">
        <Card title="身体" :dim="agoText(vitals?.now?.ages?.body)">
          <div class="stack" style="gap: 12px">
            <div v-for="b in BODY" :key="b.key">
              <div class="row spread" style="margin-bottom: 4px; align-items: baseline">
                <span class="small"><span style="margin-right: 5px">{{ b.icon }}</span>{{ b.label }}</span>
                <span class="row" style="gap: 6px; align-items: baseline">
                  <span
                    v-if="trendOf(b.key)"
                    class="tiny"
                    :style="{ color: trendOf(b.key).up ? 'var(--warn)' : 'var(--ok)' }"
                  >{{ trendOf(b.key).up ? '↑' : '↓' }}{{ Math.round(trendOf(b.key).delta * 100) }}</span>
                  <span class="mono muted small">{{ Math.round(latest(b.key) * 100) }}%</span>
                </span>
              </div>
              <div class="meter">
                <i :style="{ width: `${latest(b.key) * 100}%`, background: b.color }" />
              </div>
            </div>
            <div>
              <div class="label">她自己的描述</div>
              <div class="dim">{{ her.body.note || '没什么特别的感觉' }}</div>
            </div>
          </div>
        </Card>

        <Card title="今天" :dim="stats.day || ''">
          <div class="stack" style="gap: 12px">
            <div class="row" style="gap: 18px; flex-wrap: wrap">
              <div>
                <div class="stat-num" style="color: var(--brand)">{{ stats.her ?? 0 }}</div>
                <div class="label">她说了</div>
              </div>
              <div>
                <div class="stat-num">{{ stats.other ?? 0 }}</div>
                <div class="label">对方说了</div>
              </div>
              <div>
                <div class="stat-num">{{ stats.longestQuietMin ?? 0 }}<span class="tiny muted"> 分</span></div>
                <div class="label">最长沉默</div>
              </div>
            </div>
            <div class="hours" :title="`近 24 小时，每根柱子是一小时`">
              <div v-for="b in activity" :key="b.hour" class="hour" :title="`${b.hour} 她 ${b.her} / 对方 ${b.other}`">
                <div class="stack-bar">
                  <i class="other" :style="{ height: `${(b.other / maxBar) * 100}%` }" />
                  <i class="her" :style="{ height: `${(b.her / maxBar) * 100}%` }" />
                </div>
                <div class="hour-label">{{ b.hour.slice(0, 2) }}</div>
              </div>
            </div>
            <div class="hint">
              柱子：<span style="color: var(--brand)">她</span> / 灰蓝=对方；横轴是最近 24 小时。
              第一次开口 {{ stats.firstAt ? fmtClock(stats.firstAt) : '—' }}，最后一次 {{ stats.lastAt ? fmtClock(stats.lastAt) : '—' }}。
            </div>
          </div>
        </Card>
      </div>

      <Card title="身体与心情 · 近 24 小时" :dim="hasSeries ? `${vitals.series.length} 个采样` : '刚开始记录'">
        <div v-if="!hasSeries" class="hint" style="padding: 8px 0">
          还没有足够的历史点。她每次改写身体/心情时，桥接会把一条采样写进 <code>state/vitals.jsonl</code>，
          攒够两个点这里就会画出曲线（大概一天就有 10~20 个点）。
        </div>
        <div v-else class="stack" style="gap: 8px">
          <svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none">
            <path v-for="b in BODY" :key="b.key" :d="seriesPath(b.key)" fill="none"
                  :stroke="b.color" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="row" style="gap: 14px; flex-wrap: wrap">
            <span v-for="b in BODY" :key="b.key" class="row tiny" style="gap: 5px; align-items: center">
              <i class="dot" :style="{ background: b.color }" />{{ b.label }}
              <b class="mono">{{ Math.round(latest(b.key) * 100) }}%</b>
            </span>
          </div>
          <div class="hint">纵轴 0~100%，横轴最近 24 小时；时间点来自她每次 qq_body / qq_mood。</div>
        </div>
      </Card>

      <Card title="她心里现在的六件事" dim="她自己写的，不是推断">
        <div class="inner-grid">
          <div v-for="f in INNER" :key="f.key" class="inner-cell">
            <div class="label"><span style="margin-right: 5px">{{ f.icon }}</span>{{ f.label }}</div>
            <div class="inner-text">{{ her.inner[f.key] || '—' }}</div>
          </div>
        </div>
      </Card>
    </template>
  </template>

  <template v-else>
    <div class="row spread" style="margin-bottom: 12px">
      <div class="row">
        <select v-model="day" class="select" style="width: 180px">
          <option v-for="d in days" :key="d" :value="d">{{ d }}</option>
          <option v-if="!days.length" :value="day">{{ day }}</option>
        </select>
        <span v-if="journal" class="badge">{{ journal.messages.length }} 条</span>
        <input
          v-model="q"
          class="input"
          style="width: 220px"
          placeholder="搜聊天记录…"
          @keyup.enter="runSearch"
        />
        <button class="btn sm" :disabled="searching" @click="runSearch">{{ searching ? '搜…' : '搜索' }}</button>
      </div>
      <button class="btn sm" @click="loadJournal">刷新</button>
    </div>

    <Card v-if="searched" title="聊天搜索" :dim="`${hits.length} 条`" tight style="margin-bottom: 12px">
      <div v-if="!hits.length" class="empty" style="padding: 20px 12px">没有找到</div>
      <div v-else class="list">
        <div v-for="(h, i) in hits" :key="`${h.day}:${i}`" class="list-item" @click="openHit(h)">
          <div style="min-width: 0">
            <div class="t truncate">{{ who(h) }} · {{ h.day }} {{ fmtClock(h.t) }}</div>
            <div class="muted small truncate">{{ h.text }}</div>
          </div>
        </div>
      </div>
    </Card>

    <Card flush>
      <div v-if="!journal || !journal.messages.length" class="empty">
        <span class="big-ico">🗒️</span>这一天还没有对话
      </div>
      <div v-else ref="timeline" class="timeline">
        <div v-for="(m, i) in journal.messages" :key="i" class="msg" :class="m.role">
          <div class="who">{{ who(m) }} · {{ fmtClock(m.t) }}</div>
          <div class="text">{{ m.text }}</div>
        </div>
      </div>
    </Card>
    <div class="hint">来自 state/journal/&lt;日期&gt;.jsonl，只读。</div>
  </template>
</template>
