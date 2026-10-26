<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { get } from '../api.js';
import { toastError, fmtTime } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import Card from '../components/Card.vue';

const KINDS = [
  { key: 'diary', label: '日记', icon: '📔' },
  { key: 'memoir', label: '回忆录', icon: '📖' },
  { key: 'dreams', label: '梦', icon: '🌙' },
  { key: 'fantasies', label: '幻想', icon: '✨' },
  { key: 'knowledge', label: '知识', icon: '💡' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));

const route = useRoute();
const startKind = KINDS.some((k) => k.key === route.query.kind) ? route.query.kind : 'diary';
const kind = ref(startKind);
const items = ref([]);
const current = ref(null);
const reading = ref(false);
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const results = ref([]);
const searching = ref(false);
const pendingOpenId = ref('');
let searchTimer;

const listTitle = computed(() => KINDS.find((k) => k.key === kind.value)?.label ?? '');
const isMarkdown = computed(() => kind.value === 'diary' || kind.value === 'memoir');
const html = computed(() => (current.value ? renderMarkdown(current.value.content ?? '') : ''));
const searchingMode = computed(() => Boolean(q.value.trim()));

function kindLabel(k) { return KIND_LABEL[k] ?? k; }

function itemTitle(item) {
  if (kind.value === 'knowledge') return item.title || '一条知识';
  if (kind.value === 'dreams') return item.title || '一个梦';
  if (kind.value === 'fantasies') return item.title || '一条幻想';
  return item.title;
}

function itemMeta(item) {
  if (kind.value === 'dreams' || kind.value === 'fantasies' || kind.value === 'knowledge') {
    return fmtTime(item.at) || '';
  }
  return '';
}

async function loadList() {
  try {
    const r = await get(`/memory/${kind.value}`);
    items.value = r.items ?? [];
    const want = pendingOpenId.value;
    pendingOpenId.value = '';
    if (want) {
      const hit = items.value.find((x) => String(x.id) === String(want));
      if (hit) { await open(hit); return; }
    }
    current.value = null;
    if (items.value.length) await open(items.value[0]);
  } catch (e) { toastError(e); }
}

async function open(item) {
  reading.value = true;
  try {
    current.value = { ...item, ...(await get(`/memory/${kind.value}/${encodeURIComponent(item.id)}`)) };
  } catch (e) {
    toastError(e);
    current.value = null;
  } finally {
    reading.value = false;
  }
}

async function runSearch() {
  const text = q.value.trim();
  if (!text) { results.value = []; searching.value = false; return; }
  searching.value = true;
  try {
    const r = await get(`/memory/search?q=${encodeURIComponent(text)}`);
    if (q.value.trim() === text) results.value = r.items ?? [];
  } catch (e) {
    toastError(e);
  } finally {
    searching.value = false;
  }
}

function openResult(r) {
  pendingOpenId.value = r.id;
  q.value = '';
  if (kind.value === r.kind) loadList();
  else kind.value = r.kind;
}

watch(q, (v) => {
  clearTimeout(searchTimer);
  if (!v.trim()) { results.value = []; searching.value = false; return; }
  searchTimer = setTimeout(runSearch, 250);
});

onMounted(async () => {
  await loadList();
  if (q.value.trim()) runSearch();
});
watch(kind, loadList);
</script>

<template>
  <div class="tabs" style="margin-bottom: 14px">
    <div v-for="k in KINDS" :key="k.key" class="tab" :class="{ active: kind === k.key }" @click="kind = k.key">
      {{ k.icon }} {{ k.label }}
    </div>
  </div>

  <div class="row" style="margin-bottom: 14px; gap: 10px">
    <input v-model="q" class="input" placeholder="搜日记、回忆录、梦、幻想、知识…" style="max-width: 380px" />
    <span v-if="searchingMode" class="muted small">{{ searching ? '搜索中…' : `${results.length} 条结果` }}</span>
    <span v-else class="muted small">输入关键词，跨全部记忆找</span>
  </div>

  <template v-if="searchingMode">
    <Card title="搜索结果" :dim="`${results.length} 条`" tight>
      <div v-if="!results.length" class="empty" style="padding: 28px 12px">
        {{ searching ? '搜索中…' : '没有找到' }}
      </div>
      <div v-else class="list">
        <div
          v-for="r in results" :key="`${r.kind}:${r.id}`"
          class="list-item" @click="openResult(r)"
        >
          <div style="min-width: 0">
            <div class="t truncate">{{ r.title }}</div>
            <div class="muted small truncate">{{ kindLabel(r.kind) }} · {{ r.snippet }}</div>
          </div>
        </div>
      </div>
    </Card>
  </template>

  <div v-else class="split">
    <div class="side">
      <Card :title="listTitle" :dim="`${items.length} 条`" tight>
        <div v-if="!items.length" class="empty" style="padding: 28px 12px">还没有</div>
        <div v-else class="list">
          <div
            v-for="it in items" :key="it.id"
            class="list-item" :class="{ active: current?.id === it.id }"
            @click="open(it)"
          >
            <div style="min-width: 0">
              <div class="t truncate">{{ itemTitle(it) }}</div>
              <div class="muted small truncate">
                {{ itemMeta(it) || it.excerpt || '' }}
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>

    <div>
      <Card v-if="!current" title="读一条">
        <div class="empty"><span class="big-ico">📚</span>左边选一条</div>
      </Card>
      <Card v-else :title="itemTitle(current)" :dim="current.mtime ? fmtTime(current.mtime) : current.id">
        <div v-if="reading" class="empty">读取中…</div>
        <template v-else>
          <div v-if="current.at || current.mtime || current.tags?.length" class="row" style="margin-bottom: 14px; flex-wrap: wrap">
            <span class="badge">{{ kind === 'dreams' ? '梦' : kind === 'fantasies' ? (current.tag || '幻想') : listTitle }}</span>
            <span v-if="current.at" class="muted small">{{ fmtTime(current.at) }}</span>
            <span v-else-if="current.mtime" class="muted small">{{ fmtTime(current.mtime) }}</span>
            <span v-if="current.feel" class="badge brand">感觉：{{ current.feel }}</span>
            <span v-for="t in current.tags || []" :key="t" class="badge">#{{ t }}</span>
          </div>
          <div v-if="isMarkdown" class="prose" v-html="html" />
          <div v-else class="prose" style="white-space: pre-wrap">{{ current.content }}</div>
        </template>
      </Card>
    </div>
  </div>
</template>
