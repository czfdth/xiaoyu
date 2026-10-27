<script setup>
import { computed, onMounted, ref } from 'vue';
import { get, post } from '../api.js';
import { toastError, fmtTime } from '../store.js';
import Card from '../components/Card.vue';

const wall = ref(null);
const month = ref('');
const tab = ref('art');
const preview = ref(null);
const report = ref(null);
const generating = ref(false);
const reports = ref([]);

const months = computed(() => wall.value?.months ?? []);
const items = computed(() => {
  if (tab.value === 'art') return wall.value?.art ?? [];
  if (tab.value === 'sticker') return wall.value?.stickers ?? [];
  return wall.value?.memes ?? [];
});
const totals = computed(() => wall.value?.totals ?? { art: 0, sticker: 0, meme: 0, all: 0 });

function url(name) {
  return `/api/works/image/${encodeURIComponent(name)}`;
}

async function load(monthValue = '') {
  try {
    const q = monthValue ? `?month=${encodeURIComponent(monthValue)}` : '';
    wall.value = await get(`/works/wall${q}`);
    month.value = wall.value.selected;
  } catch (e) { toastError(e); }
}

async function loadReports() {
  try { reports.value = await get('/reports'); } catch { /* 没有历史小结 */ }
}

async function makeReport() {
  if (generating.value) return;
  generating.value = true;
  try {
    const r = await post('/reports/monthly', { month: month.value });
    report.value = r;
    await loadReports();
  } catch (e) { toastError(e); } finally { generating.value = false; }
}

onMounted(async () => {
  await load();
  await loadReports();
  report.value = reports.value.find((r) => r.name === `month-${month.value}.md`) ?? null;
});
</script>

<template>
  <div class="row spread" style="margin-bottom: 14px; flex-wrap: wrap; gap: 10px">
    <div class="row" style="gap: 6px; flex-wrap: wrap">
      <button
        v-for="m in months" :key="m.month"
        class="btn sm" :class="m.month === month ? 'primary' : 'ghost'"
        @click="load(m.month)"
      >
        {{ m.month }}<span class="tiny muted" style="margin-left: 5px">{{ m.art }}</span>
      </button>
      <span v-if="!months.length" class="muted small">还没有画</span>
    </div>
    <button class="btn sm ghost" @click="makeReport">{{ generating ? '生成中…' : '生成这个月的小结' }}</button>
  </div>

  <div class="row" style="gap: 14px; margin-bottom: 12px; flex-wrap: wrap">
    <span class="badge">她画的 {{ totals.art }}</span>
    <span class="badge">表情 {{ totals.sticker }}</span>
    <span class="badge">梗图 {{ totals.meme }}</span>
    <span class="muted small">共 {{ totals.all }} 张图</span>
  </div>

  <div class="tabs" style="margin-bottom: 14px">
    <div class="tab" :class="{ active: tab === 'art' }" @click="tab = 'art'">她画的</div>
    <div class="tab" :class="{ active: tab === 'sticker' }" @click="tab = 'sticker'">表情</div>
    <div class="tab" :class="{ active: tab === 'meme' }" @click="tab = 'meme'">梗图</div>
  </div>

  <Card v-if="report" title="这个月的小结" :dim="report.month || ''" style="margin-bottom: 14px">
    <pre class="report-text">{{ report.text }}</pre>
    <div class="hint">存在 state/reports/month-{{ report.month }}.md。</div>
  </Card>

  <Card flush>
    <div v-if="!items.length" class="empty">
      <span class="big-ico">🎨</span>这个月还没有{{ tab === 'art' ? '画' : '图' }}
    </div>
    <div v-else class="art-grid">
      <figure v-for="it in items" :key="it.name" class="art-cell" @click="preview = it">
        <img :src="url(it.name)" :alt="it.name" loading="lazy" />
        <figcaption class="art-cap">
          <span class="truncate">{{ it.name }}</span>
          <span class="tiny muted">{{ fmtTime(it.at) }}</span>
        </figcaption>
      </figure>
    </div>
  </Card>

  <div v-if="preview" class="lightbox" @click="preview = null">
    <img :src="url(preview.name)" :alt="preview.name" />
    <div class="lightbox-cap">{{ preview.name }} · {{ fmtTime(preview.at) }} —— 点任意处关闭</div>
  </div>
</template>

<style scoped>
.art-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  padding: 14px;
  max-height: 68vh;
  overflow: auto;
}
.art-cell {
  margin: 0;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-soft);
  cursor: zoom-in;
}
.art-cell img { display: block; width: 100%; height: 130px; object-fit: cover; }
.art-cap {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 8px; font-size: 11px; color: var(--muted);
}
.report-text {
  margin: 0; white-space: pre-wrap; font-size: 13px; line-height: 1.7;
  font-family: inherit; color: var(--text);
}
.lightbox {
  position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, .78);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  cursor: zoom-out; padding: 24px;
}
.lightbox img { max-width: 92vw; max-height: 80vh; border-radius: 10px; }
.lightbox-cap { color: var(--text-dim); font-size: 12px; }
</style>
