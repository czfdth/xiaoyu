<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { get } from '../api.js';
import { toastError, fmtTime } from '../store.js';
import { renderMarkdown } from '../markdown.js';
import Card from '../components/Card.vue';

const KINDS = [
  { key: 'diary', label: '日记', icon: '📔' },
  { key: 'memoir', label: '回忆录', icon: '📖' },
  { key: 'dreams', label: '梦', icon: '🌙' },
  { key: 'fantasies', label: '幻想', icon: '✨' },
];

const kind = ref('diary');
const items = ref([]);
const current = ref(null);
const reading = ref(false);

const listTitle = computed(() => KINDS.find((k) => k.key === kind.value)?.label ?? '');
const isMarkdown = computed(() => kind.value === 'diary' || kind.value === 'memoir');
const html = computed(() => (current.value ? renderMarkdown(current.value.content ?? '') : ''));

function itemTitle(item) {
  if (kind.value === 'dreams') return item.title || '一个梦';
  if (kind.value === 'fantasies') return item.title || '一条幻想';
  return item.title;
}

function itemMeta(item) {
  if (kind.value === 'dreams' || kind.value === 'fantasies') return fmtTime(item.at) || '';
  return '';
}

async function loadList() {
  try {
    const r = await get(`/memory/${kind.value}`);
    items.value = r.items ?? [];
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

onMounted(loadList);
watch(kind, loadList);
</script>

<template>
  <div class="tabs" style="margin-bottom: 14px">
    <div v-for="k in KINDS" :key="k.key" class="tab" :class="{ active: kind === k.key }" @click="kind = k.key">
      {{ k.icon }} {{ k.label }}
    </div>
  </div>

  <div class="split">
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
          <div v-if="current.at || current.mtime" class="row" style="margin-bottom: 14px">
            <span class="badge">{{ kind === 'dreams' ? '梦' : kind === 'fantasies' ? (current.tag || '幻想') : listTitle }}</span>
            <span v-if="current.at" class="muted small">{{ fmtTime(current.at) }}</span>
            <span v-else-if="current.mtime" class="muted small">{{ fmtTime(current.mtime) }}</span>
            <span v-if="current.feel" class="badge brand">感觉：{{ current.feel }}</span>
          </div>
          <div v-if="isMarkdown" class="prose" v-html="html" />
          <div v-else class="prose" style="white-space: pre-wrap">{{ current.content }}</div>
        </template>
      </Card>
    </div>
  </div>
</template>
