<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { get, post } from '../api.js';
import { toast, toastError, fmtTime } from '../store.js';
import Card from '../components/Card.vue';

const data = ref(null);
const loading = ref(true);
const error = ref('');
const q = ref('');
const sort = ref('usage');
const busy = reactive({});
const verifying = reactive({});
const verifyResults = reactive({});

async function load(refresh = false) {
  loading.value = true;
  error.value = '';
  try {
    data.value = await get(`/tools${refresh ? '?refresh=1' : ''}`);
  } catch (e) {
    error.value = String(e?.message ?? e);
    toastError(e);
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());

function usageText(t) {
  const u = t.usage || {};
  if (!u.calls && !u.ok && !u.fail) return '没用过';
  const parts = [`用过 ${u.calls || 0} 次`];
  if (u.fail) parts.push(`失败 ${u.fail}`);
  if (u.lastAt) {
    const mins = Math.max(0, Math.round((Date.now() - u.lastAt) / 60000));
    const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
    parts.push(`最近 ${when}`);
  }
  return parts.join(' · ');
}

const groups = computed(() => {
  const d = data.value;
  if (!d) return [];
  const kw = q.value.trim().toLowerCase();
  const filtered = d.groups
    .map((g) => ({
      ...g,
      tools: g.tools
        .filter((t) => !kw
          || t.name.toLowerCase().includes(kw)
          || String(t.desc || '').toLowerCase().includes(kw))
        .slice()
        .sort((a, b) => (sort.value === 'name'
          ? a.name.localeCompare(b.name)
          : ((b.usage?.calls || 0) - (a.usage?.calls || 0)) || a.name.localeCompare(b.name))),
    }))
    .filter((g) => g.tools.length);
  return filtered;
});

const shown = computed(() => groups.value.reduce((n, g) => n + g.tools.length, 0));
const caps = computed(() => data.value?.capabilities ?? {});
const enabledTotal = computed(() => data.value?.enabledTotal ?? 0);
const disabledTotal = computed(() => data.value?.disabledTotal ?? 0);

async function toggle(t) {
  if (busy[t.name]) return;
  busy[t.name] = true;
  try {
    const next = !t.enabled;
    await post('/tools/toggle', { name: t.name, enabled: next });
    t.enabled = next;
    delete verifyResults[t.name];
    toast(
      next
        ? `已开启 ${t.name}；重启 DSH 后它才会重新出现在工具里（桥接已放行）`
        : `已停用 ${t.name}；桥接会立即拒绝调用（MCP 里要重启 DSH 才消失）`,
      'ok',
      5200,
    );
  } catch (e) {
    toastError(e);
  } finally {
    busy[t.name] = false;
  }
}

async function verify(t) {
  if (verifying[t.name]) return;
  verifying[t.name] = true;
  try {
    const r = await get(`/tools/verify?name=${encodeURIComponent(t.name)}`);
    verifyResults[t.name] = r;
    toast(r.verdict, r.needRestart ? 'warn' : 'ok', 7000);
  } catch (e) {
    toastError(e);
  } finally {
    verifying[t.name] = false;
  }
}
</script>

<template>
  <div v-if="error" class="banner err">
    <span>⛔</span>
    <div>
      <b>拿不到工具清单</b>
      <div class="small" style="margin-top: 2px">{{ error }}</div>
      <button class="btn sm" style="margin-top: 8px" @click="load(true)">重试</button>
    </div>
  </div>

  <div class="stack">
    <Card title="她现在能用的工具" :dim="loading ? '正在问 MCP…' : `共 ${data?.total ?? 0} 个`">
      <template #actions>
        <button class="btn sm" :disabled="loading" @click="load(true)">刷新</button>
      </template>

      <div class="row" style="gap: 8px">
        <span class="pill"><b>{{ data?.total ?? 0 }}</b> 个工具</span>
        <span class="pill"><span class="dot ok" /><b>启用 {{ enabledTotal }}</b></span>
        <span class="pill"><span class="dot" :class="disabledTotal ? 'warn' : 'idle'" /><b>停用 {{ disabledTotal }}</b></span>
        <span class="pill"><span class="dot" :class="caps.snowluma ? 'ok' : 'bad'" /><b>接 QQ</b></span>
        <span class="pill"><span class="dot" :class="caps.voice ? 'ok' : 'bad'" /><b>声音</b></span>
        <span class="pill"><span class="dot" :class="caps.sing ? 'ok' : 'bad'" /><b>唱歌</b></span>
      </div>

      <div class="row" style="margin-top: 14px; gap: 10px">
        <input
          v-model="q"
          class="input"
          style="max-width: 320px"
          placeholder="搜工具名 / 描述，例如 图片、提醒、pc"
        />
        <select v-model="sort" class="select" style="width: 130px">
          <option value="usage">按使用次数</option>
          <option value="name">按名称</option>
        </select>
        <span class="muted small">显示 {{ shown }} / {{ data?.total ?? 0 }}</span>
      </div>

      <div class="hint" style="margin-top: 10px">
        停用立即生效（桥接会拒绝调用）；重新启用后，工具要等 DSH 重启才会出现在模型的工具列表里。
        同一个开关管着多个工具时会一起变（比如 qq_send_voice 和 qq_list_voices）。
      </div>
    </Card>

    <Card v-if="data?.recent?.length" title="最近调用" :dim="`${data.recent.length} 条`">
      <div class="stack" style="gap: 6px">
        <div
          v-for="(r, i) in data.recent" :key="i"
          class="row"
          style="gap: 10px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px"
        >
          <span class="badge" :class="r.ok === true ? 'ok' : r.ok === false ? 'warn' : ''">
            {{ r.ok === true ? '成功' : r.ok === false ? '失败' : '进行中' }}
          </span>
          <span class="mono" style="min-width: 180px">{{ r.tool }}</span>
          <span class="muted small" style="flex: 1; min-width: 0">{{ r.key }}</span>
          <span class="muted small">{{ fmtTime(r.at) }}</span>
        </div>
      </div>
    </Card>

    <Card v-for="g in groups" :key="g.id" :title="g.label" :dim="`${g.tools.length} 个`">
      <div class="stack" style="gap: 8px">
        <div
          v-for="t in g.tools"
          :key="t.name"
          class="tool-row"
          :style="{ display: 'flex', gap: '12px', alignItems: 'center', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: '8px', opacity: t.enabled ? 1 : 0.55 }"
        >
          <div class="mono" style="min-width: 200px; color: var(--text)">
            {{ t.name }}
            <span v-if="!t.enabled" class="badge warn" style="margin-left: 6px">停用</span>
          </div>
          <div style="flex: 1">
            <div class="muted small">{{ t.desc || '（没有描述）' }}</div>
            <div class="muted small" style="margin-top: 3px">{{ usageText(t) }}</div>
            <div v-if="verifyResults[t.name]" class="small" style="margin-top: 4px">
              <span :style="{ color: verifyResults[t.name].needRestart ? 'var(--warn)' : 'var(--ok)' }">
                {{ verifyResults[t.name].verdict }}
              </span>
              <span v-if="verifyResults[t.name].needRestart" class="badge warn" style="margin-left: 6px">需重启 DSH</span>
            </div>
          </div>
          <div class="row" style="gap: 4px">
            <span v-for="tag in t.tags" :key="tag" class="badge">{{ tag }}</span>
            <span v-if="t.shared > 1" class="badge">联动 {{ t.shared }}</span>
          </div>
          <button
            class="btn sm"
            :disabled="verifying[t.name]"
            @click="verify(t)"
          >
            {{ verifying[t.name] ? '验证中…' : '验证' }}
          </button>
          <button
            class="btn sm"
            :class="t.enabled ? 'ghost' : 'primary'"
            :disabled="busy[t.name]"
            @click="toggle(t)"
          >
            {{ t.enabled ? '停用' : '启用' }}
          </button>
        </div>
      </div>
    </Card>

    <Card v-if="!loading && !groups.length" title="没有匹配">
      <div class="muted small">换个关键词试试，或者点右上角刷新。</div>
    </Card>
  </div>
</template>
