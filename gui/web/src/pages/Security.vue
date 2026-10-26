<script setup>
import { computed, onMounted, ref } from 'vue';
import { get } from '../api.js';
import { toastError, fmtTime } from '../store.js';
import Card from '../components/Card.vue';

const data = ref(null);
const loading = ref(false);
const filter = ref('all');
const q = ref('');

const REASONS = [
  { key: 'all', label: '全部' },
  { key: 'agent-leak', label: '代理串台' },
  { key: 'known-token', label: '会话令牌' },
  { key: 'sensitive', label: '敏感信息' },
];

const filtered = computed(() => {
  const items = data.value?.items ?? [];
  const text = q.value.trim().toLowerCase();
  return items.filter((x) => {
    if (filter.value !== 'all' && x.reason !== filter.value) return false;
    if (!text) return true;
    return `${x.text} ${x.key}`.toLowerCase().includes(text);
  });
});

function reasonLabel(r) {
  if (r === 'agent-leak') return '代理串台';
  if (r === 'known-token') return '会话令牌';
  return '敏感信息';
}

async function load() {
  loading.value = true;
  try {
    data.value = await get('/security/blocks?limit=200');
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="row spread" style="margin-bottom: 14px">
    <div class="hint">
      回复发出前会过本地安全策略；被拦下的原文（脱敏后）留在这里，方便判断是不是误伤。
    </div>
    <button class="btn sm" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
  </div>

  <template v-if="data">
    <div class="grid cols-3" style="margin-bottom: 14px">
      <Card title="全部拦截" :dim="'累计'">
        <div class="big">{{ data.total }}</div>
        <div class="muted small">最近 24 小时 {{ data.last24h }} 条</div>
      </Card>
      <Card title="代理串台" :dim="'agent-leak'">
        <div class="big">{{ data.reasons.agentLeak }}</div>
        <div class="muted small">编码代理格式串进聊天</div>
      </Card>
      <Card title="令牌 / 敏感信息" :dim="'known-token + sensitive'">
        <div class="big">{{ data.reasons.knownToken + data.reasons.sensitive }}</div>
        <div class="muted small">路径、凭据、会话令牌</div>
      </Card>
    </div>

    <Card title="拦截记录" :dim="`${filtered.length} 条`">
      <template #actions>
        <div class="row" style="gap: 6px">
          <button
            v-for="r in REASONS" :key="r.key"
            class="btn sm" :class="{ primary: filter === r.key }"
            @click="filter = r.key"
          >{{ r.label }}</button>
        </div>
        <input v-model="q" class="input" style="width: 180px" placeholder="搜原文…" />
      </template>

      <div v-if="!filtered.length" class="empty">
        <span class="big-ico">🛡️</span>
        {{ data.total ? '这个筛选下没有记录' : '还没有拦截记录——这是好事' }}
        <div v-if="!data.total" class="hint" style="margin-top: 8px">
          记录写在 state/security-blocks.jsonl；下次真的拦下一条时会出现在这里。
        </div>
      </div>

      <div v-else class="stack" style="gap: 10px">
        <div v-for="b in filtered" :key="b.id" class="card" style="padding: 12px 14px; background: var(--bg-soft)">
          <div class="row spread" style="margin-bottom: 6px">
            <div class="row" style="gap: 8px">
              <span class="badge warn">{{ reasonLabel(b.reason) }}</span>
              <span v-if="b.hasKnownToken" class="badge">含已知令牌</span>
              <span class="mono muted small">{{ b.key || '未知会话' }}</span>
            </div>
            <span class="muted small">{{ fmtTime(b.at) }}</span>
          </div>
          <div class="prose" style="white-space: pre-wrap; font-size: 13px">{{ b.text }}</div>
        </div>
      </div>
    </Card>
  </template>

  <div v-else class="empty">读取中…</div>
</template>
