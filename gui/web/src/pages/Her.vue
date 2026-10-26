<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { get } from '../api.js';
import { toastError, fmtClock, fmtTime, pct } from '../store.js';
import Card from '../components/Card.vue';

const route = useRoute();

const tab = ref(route.query.tab === 'talk' || route.query.q ? 'talk' : 'state');
const her = ref(null);
const days = ref([]);
const day = ref('');
const journal = ref(null);
const timeline = ref(null);
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const hits = ref([]);
const searching = ref(false);
const searched = ref(false);

const BODY = [
  { key: 'sleepy', label: '困' },
  { key: 'hungry', label: '饿' },
  { key: 'cold', label: '冷' },
  { key: 'tired', label: '累' },
];

const INNER = [
  { key: 'doing', label: '在做' },
  { key: 'thinking', label: '在想' },
  { key: 'worrying', label: '惦记' },
  { key: 'lastTopic', label: '上次说到' },
  { key: 'curious', label: '好奇' },
  { key: 'mood', label: '心情' },
];

async function loadHer() {
  try { her.value = await get('/her'); } catch (e) { toastError(e); }
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
    hits.value = r.items ?? [];
    searched.value = true;
  } catch (e) {
    toastError(e);
  } finally {
    searching.value = false;
  }
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

onMounted(async () => {
  if (q.value.trim()) tab.value = 'talk';
  await Promise.all([loadHer(), loadDays()]);
  await loadJournal();
  if (q.value.trim()) runSearch();
});

watch(tab, (v) => { if (v === 'talk') loadJournal(); });
watch(day, loadJournal);
</script>

<template>
  <div class="tabs" style="margin-bottom: 16px">
    <div class="tab" :class="{ active: tab === 'state' }" @click="tab = 'state'">状态</div>
    <div class="tab" :class="{ active: tab === 'talk' }" @click="tab = 'talk'">对话</div>
  </div>

  <template v-if="tab === 'state'">
    <div v-if="!her" class="empty">读取中…</div>
    <template v-else>
      <div class="grid cols-2">
        <Card title="她从哪来" :dim="her.role ? `当前人格卡：${her.role}` : ''">
          <div class="grid cols-2">
            <div v-for="f in INNER" :key="f.key">
              <div class="label">{{ f.label }}</div>
              <div class="dim">{{ her.inner[f.key] || '—' }}</div>
            </div>
          </div>
        </Card>

        <Card title="身体">
          <div class="stack" style="gap: 14px">
            <div v-for="b in BODY" :key="b.key">
              <div class="row spread" style="margin-bottom: 5px">
                <span class="small dim">{{ b.label }}</span>
                <span class="mono muted small">{{ Math.round(pct(her.body[b.key]) * 100) }}%</span>
              </div>
              <div class="meter"><i :style="{ width: `${pct(her.body[b.key]) * 100}%` }" /></div>
            </div>
            <div>
              <div class="label">备注</div>
              <div class="dim">{{ her.body.note || '没什么特别的感觉' }}</div>
            </div>
          </div>
        </Card>
      </div>

      <Card title="心情">
        <div class="row" style="align-items: baseline; gap: 14px">
          <span class="big">{{ her.mood.mood || '平静' }}</span>
          <span class="dim">{{ her.mood.why || '' }}</span>
          <span v-if="her.mood.at" class="muted small">{{ fmtTime(her.mood.at) }}</span>
        </div>
        <div class="hint" style="margin-top: 8px">
          这些是桥接读 state/ 得到的；她自己会在对话里用工具改写它们（qq_mood / qq_body / qq_inner_state）。
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
