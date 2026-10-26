<script setup>
import { computed, onMounted, ref } from 'vue';
import { get, post } from '../api.js';
import { toastError, fmtTime } from '../store.js';
import Card from '../components/Card.vue';

const data = ref(null);
const loading = ref(false);
const filter = ref('all');
const q = ref('');
const replayText = ref('');
const replayKnown = ref(false);
const replayResult = ref(null);
const replaying = ref(false);

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

async function runReplay(text = replayText.value, known = replayKnown.value) {
  replayText.value = text;
  replayKnown.value = known;
  replaying.value = true;
  try {
    replayResult.value = await post('/security/replay', { text, knownToken: known });
  } catch (e) {
    toastError(e);
  } finally {
    replaying.value = false;
  }
}

function replayRecord(b) {
  runReplay(b.text, b.hasKnownToken);
}

function exportUrl(format) {
  const p = new URLSearchParams({ format, limit: '5000' });
  if (filter.value !== 'all') p.set('reason', filter.value);
  if (q.value.trim()) p.set('q', q.value.trim());
  return `/api/security/export?${p.toString()}`;
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

    <Card title="误伤回放" :dim="'只在本机跑规则，不发消息'" style="margin-bottom: 14px">
      <textarea
        v-model="replayText"
        class="input"
        style="width: 100%; min-height: 76px; resize: vertical"
        placeholder="粘一段想验证的话：是不是真的会被拦？"
      ></textarea>
      <div class="row" style="gap: 10px; margin-top: 10px; flex-wrap: wrap">
        <button class="btn sm primary" :disabled="replaying || !replayText.trim()" @click="runReplay()">
          {{ replaying ? '回放中…' : '回放这段' }}
        </button>
        <label class="row" style="gap: 6px; cursor: pointer">
          <input v-model="replayKnown" type="checkbox" style="width: auto" />
          <span class="muted small">当作含已知会话令牌</span>
        </label>
        <span class="hint">只做正则匹配，不读取、不写盘、不调用网关。</span>
      </div>

      <div v-if="replayResult" class="card" style="margin-top: 12px; padding: 12px 14px; background: var(--bg-soft)">
        <div class="row spread" style="margin-bottom: 8px">
          <div class="row" style="gap: 8px">
            <span class="badge" :class="{ warn: replayResult.wouldBlock }">
              {{ replayResult.wouldBlock ? '会被拦下' : '不会被拦' }}
            </span>
            <span v-if="replayResult.reason" class="muted small">原因：{{ reasonLabel(replayResult.reason) }}</span>
          </div>
          <span class="muted small">{{ fmtTime(replayResult.checkedAt) }}</span>
        </div>
        <div v-if="replayResult.signals.length" class="stack" style="gap: 8px">
          <div v-for="s in replayResult.signals" :key="s.rule">
            <div class="small"><strong>{{ s.label }}</strong></div>
            <div v-if="s.matches.length" class="stack" style="gap: 4px; margin-top: 4px">
              <code v-for="(m, i) in s.matches" :key="i" class="mono small" style="white-space: pre-wrap">{{ m.snippet }}</code>
            </div>
            <div v-else class="hint small">由运行期令牌名单命中，没有可展示的片段。</div>
          </div>
        </div>
        <div v-else class="hint">规则没有命中：这段话会正常发出去。</div>
      </div>
    </Card>

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
        <a class="btn sm ghost" :href="exportUrl('csv')" download>导出 CSV</a>
        <a class="btn sm ghost" :href="exportUrl('jsonl')" download>JSONL</a>
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
            <button class="btn sm" @click="replayRecord(b)">回放</button>
          </div>
          <div class="prose" style="white-space: pre-wrap; font-size: 13px">{{ b.text }}</div>
        </div>
      </div>
    </Card>
  </template>

  <div v-else class="empty">读取中…</div>
</template>
