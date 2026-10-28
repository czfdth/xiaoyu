<script setup>
// 搜她的记忆：聊天记录 / 事实 / 日记 / 知识库。
import { ref } from 'vue';
import { get } from '../api.js';

const q = ref('');
const loading = ref(false);
const result = ref(null);
const error = ref('');
let seq = 0;

async function run() {
  const text = q.value.trim();
  if (!text) { result.value = null; return; }
  const mine = ++seq;
  loading.value = true;
  error.value = '';
  try {
    const r = await get('/search?q=' + encodeURIComponent(text));
    if (mine === seq) result.value = r;
  } catch (e) {
    if (mine === seq) error.value = e?.message || '搜索失败';
  } finally {
    if (mine === seq) loading.value = false;
  }
}

function when(item) {
  if (item.at) return new Date(item.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return item.day ?? '';
}

const groups = [
  { key: 'journal', title: '聊天记录' },
  { key: 'fact', title: '她记得的事' },
  { key: 'diary', title: '日记' },
  { key: 'knowledge', title: '知识库' },
];
</script>

<template>
  <div class="stack" style="gap: 16px">
    <div class="row" style="gap: 8px">
      <input v-model="q" class="input" style="flex: 1"
             placeholder="搜她说过的话、记住的事、写过的日记…"
             @keyup.enter="run" />
      <button class="btn primary" :disabled="loading" @click="run">{{ loading ? '搜索中…' : '搜索' }}</button>
    </div>

    <div v-if="error" class="muted small">{{ error }}</div>
    <div v-else-if="result" class="muted small">共 {{ result.total }} 条 · 关键词「{{ result.query }}」</div>

    <template v-for="g in groups" :key="g.key">
      <div v-if="result?.groups?.[g.key]?.length" class="stack" style="gap: 8px">
        <div class="muted small">{{ g.title }}（{{ result.groups[g.key].length }}）</div>
        <div v-for="(item, i) in result.groups[g.key]" :key="g.key + i" class="card" style="padding: 10px 12px">
          <div class="row" style="gap: 8px; margin-bottom: 4px">
            <span class="badge">{{ when(item) }}</span>
            <span v-if="item.who" class="badge">{{ item.who }}</span>
          </div>
          <div class="small">{{ item.text }}</div>
        </div>
      </div>
    </template>

    <div v-if="result && !result.total" class="muted small">没找到。换个词试试。</div>
  </div>
</template>