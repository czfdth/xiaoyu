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
const disabledRows = computed(() => Object.values(data.value?.disabledStats ?? {})
  .sort((a, b) => b.attempts - a.attempts || b.failures - a.failures));

// 工具瘦身：从建起来一次都没被调用过的工具，描述+参数却每次请求都在重发。
// 这几个是核心收发/收尾工具，即使"暂时没用过"也别建议关掉。
const KEEP_ALWAYS = ['qq_send_message', 'qq_send_group_message', 'qq_send_private_message', 'qq_reply',
  'qq_wait_for_messages', 'qq_mark_read', 'qq_set_wake_config', 'qq_get_unread_messages',
  'qq_get_recent_messages', 'qq_get_prompt', 'qq_social_state'];
const unused = computed(() => {
  const out = [];
  for (const g of data.value?.groups ?? []) {
    for (const t of g.tools) {
      if (!t.enabled) continue;
      if (KEEP_ALWAYS.includes(t.name)) continue;
      if ((t.usage?.calls ?? 0) > 0) continue;
      out.push({ ...t, group: g.label });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
});
const picked = ref([]);
const trimming = ref(false);

async function disablePicked() {
  if (!picked.value.length || trimming.value) return;
  trimming.value = true;
  try {
    await post('/tools/toggle-bulk', { names: picked.value, enabled: false });
    toast(`已停用 ${picked.value.length} 个没用过的工具；重启 DSH 后它们从工具列表消失`, 'ok', 6000);
    picked.value = [];
    await load(true);
  } catch (e) {
    toastError(e);
  } finally {
    trimming.value = false;
  }
}

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

    <Card v-if="unused.length" title="从没用过的工具" :dim="`${unused.length} 个`">
      <div class="hint" style="margin-bottom: 10px">
        这些工具从建起来一次都没被调用过，但描述 + 参数 schema 会随每一次请求重发
        （90 个工具的说明大约 8~11k token/次）。关掉不影响现有用法，想用再开回来。
      </div>
      <div class="stack" style="gap: 6px; max-height: 42vh; overflow: auto">
        <label
          v-for="t in unused" :key="t.name"
          class="row" style="gap: 10px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer"
        >
          <input v-model="picked" type="checkbox" :value="t.name" />
          <span class="mono" style="min-width: 190px">{{ t.name }}</span>
          <span class="muted small" style="flex: 1; min-width: 0">{{ t.desc }}</span>
          <span class="badge">{{ t.group }}</span>
        </label>
      </div>
      <div class="row" style="gap: 8px; margin-top: 10px; flex-wrap: wrap">
        <button class="btn sm primary" :disabled="!picked.length || trimming" @click="disablePicked">
          {{ trimming ? '处理中…' : `停用选中的 ${picked.length} 个` }}
        </button>
        <button class="btn sm ghost" :disabled="!unused.length" @click="picked = unused.map((t) => t.name)">
          全选 {{ unused.length }} 个
        </button>
        <button class="btn sm ghost" :disabled="!picked.length" @click="picked = []">清空</button>
        <span class="hint">停用后要重启 DSH，工具才会从模型清单里消失。</span>
      </div>
    </Card>

    <Card v-if="disabledRows.length" title="停用后的调用" :dim="`${disabledRows.length} 个工具`">
      <div class="stack" style="gap: 6px">
        <div
          v-for="s in disabledRows" :key="s.name"
          class="row"
          style="gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; flex-wrap: wrap"
        >
          <span class="mono" style="min-width: 180px">{{ s.name }}</span>
          <span class="muted small">
            {{ s.disabledAt ? `停用于 ${fmtTime(Date.parse(s.disabledAt))}` : '停用时间未知' }}
          </span>
          <span class="badge">尝试 {{ s.attempts }}</span>
          <span class="badge" :class="s.failures ? 'warn' : ''">失败 {{ s.failures }}</span>
          <span v-if="s.blocked" class="badge warn">被停用拦截 {{ s.blocked }}</span>
          <span v-if="!s.attempts" class="hint small">停用后还没被调用过</span>
          <span v-if="s.lastError" class="hint small" style="flex-basis: 100%">{{ s.lastError }}</span>
        </div>
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
