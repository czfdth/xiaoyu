<script setup>
// 搜她的记忆：聊天记录 / 事实 / 日记 / 知识库。
// 数据全在后端（/api/search），这里只负责输入和分组展示。
import { ref } from 'vue';
import { get } from '../api.js';

const q = ref('');
const loading = ref(false);
const result = ref(null);
let seq = 0;

async function run() {
  const text = q.value.trim();
  if (!text) { result.value = null; return; }
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await get('/search?q=' + encodeURIComponent(text));
    if (mine === seq) result.value = r;   // 只认最后一次查询，避免慢请求覆盖新结果
  } catch { /* 失败保持上一次结果 */ } finally {
    if (mine === seq) loading.value = false;
  }
}

function when(item) {
  if (item.at) {
    return new Date(item.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
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
      <input
        v-model="q"
        class="input"
        style="flex: 1"
        placeholder="搜她说过的话、记住的事、写过的日记…"
        @keyup.enter="run"
      />
      <button class="btn primary" :disabled="loading" @click="run">{{ loading ? '搜索中…' : '搜索' }}</button>
    </div>

    <div v-if="result" class="muted small">
      共 {{ result.total }} 条结果 · 关键词「{{ result.query }}」
    </div>

    <template v-for="g in groups" :key="g.key">
      <div v-if="result?.groups?.[g.key]?.length" class="stack" style="gap: 8px">
        <div class="muted small">{{ g.title }}（{{ result.groups[g.key].length }}）</div>
        <div v-for="(item, i) in result.groups[g.key]" :key="g.key + i" class="card" style="padding: 10px 12px">
          <div class="row" style="gap: 8px; margin-bottom: 4px">
            <span class="badge">{{ when(item) }}</span>
            <span v-if="item.who" class="badge">{{ item.who }}</span>
            <span v-if="item.confidence" class="badge">可信度 {{ Math.round(item.confidence * 100) }}%</span>
          </div>
          <div class="small">{{ item.text }}</div>
        </div>
      </div>
    </template>

    <div v-if="result && !result.total" class="muted small">
      没找到。换个词试试——她只记得听见过的事。
    </div>
  </div>
</template>
