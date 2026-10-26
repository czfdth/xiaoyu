<script setup>
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from 'vue';
import { useRoute } from 'vue-router';
import { get } from '../api.js';
import { toast, toastError } from '../store.js';
import Card from '../components/Card.vue';
import Icon from '../components/Icon.vue';

const route = useRoute();
const files = ref([]);
const name = ref('bridge');
const lines = ref(200);
const auto = ref(true);
const text = ref('');
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const level = ref('all');
const since = ref('all');
const meta = ref(null);
const box = ref(null);
let timer = null;

const current = computed(() => files.value.find((f) => f.name === name.value));

function levelOf(line) {
  if (/(^|\s)(error|fatal|exception|traceback|错误|失败|❌|⛔)/i.test(line)) return 'error';
  if (/(^|\s)(warn|warning|警告|⚠️|重试|超时|timeout)/i.test(line)) return 'warn';
  return 'info';
}

function tsOf(line) {
  const full = line.match(/\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (full) return new Date(`${full[1]}T${full[2]}`).getTime();
  const hm = line.match(/^\[?(\d{2}):(\d{2}):(\d{2})/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3]), 0);
    return d.getTime();
  }
  return 0;
}

const activeFilter = computed(() => Boolean(q.value.trim()) || level.value !== 'all' || since.value !== 'all');

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  const sinceMs = since.value === 'all' ? 0 : Number(since.value) * 60000;
  const now = Date.now();
  let last = 0;
  const out = [];
  for (const line of String(text.value || '').split('\n')) {
    if (!line.trim()) continue;
    const ts = tsOf(line);
    if (ts) last = ts;
    if (sinceMs && (!last || now - last > sinceMs)) continue;
    if (level.value !== 'all' && levelOf(line) !== level.value) continue;
    if (kw && !line.toLowerCase().includes(kw)) continue;
    out.push(line);
  }
  return out.join('\n');
});

const matchCount = computed(() => (activeFilter.value ? filtered.value.split('\n').filter(Boolean).length : 0));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把过滤后的每一行按关键词切开，交给模板上色；没输入关键词时返回空。 */
const highlighted = computed(() => {
  const kw = q.value.trim();
  if (!kw) return [];
  const re = new RegExp(`(${escapeRe(kw)})`, 'gi');
  return filtered.value.split('\n').filter(Boolean).map((line) => (
    line.split(re).map((text, i) => ({ text, hit: i % 2 === 1 }))
  ));
});

async function loadFiles() {
  try {
    const r = await get('/logs');
    files.value = r.files ?? [];
  } catch (e) { toastError(e); }
}

async function load({ scroll = true } = {}) {
  if (!name.value) return;
  try {
    const r = await get(`/logs/${name.value}?lines=${lines.value}`);
    text.value = r.text || '';
    meta.value = r;
    if (scroll) {
      await nextTick();
      if (box.value) box.value.scrollTop = box.value.scrollHeight;
    }
  } catch (e) { toastError(e); }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(filtered.value);
    toast(activeFilter.value ? `已复制 ${matchCount.value} 行匹配` : '已复制');
  } catch { toast('复制失败（浏览器权限）', 'err'); }
}

function setupTimer() {
  clearInterval(timer);
  if (auto.value) timer = setInterval(() => load({ scroll: true }), 3000);
}

onMounted(async () => {
  await loadFiles();
  await load();
  setupTimer();
});
onUnmounted(() => clearInterval(timer));
watch([name, lines], () => load());
watch(auto, setupTimer);
</script>

<template>
  <div class="row spread" style="margin-bottom: 12px">
    <div class="row">
      <select v-model="name" class="select" style="width: 150px">
        <option v-for="f in files" :key="f.name" :value="f.name">{{ f.name }}</option>
      </select>
      <select v-model.number="lines" class="select" style="width: 120px">
        <option :value="100">100 行</option>
        <option :value="200">200 行</option>
        <option :value="500">500 行</option>
        <option :value="1000">1000 行</option>
      </select>
      <input v-model="q" class="input" style="width: 190px" placeholder="过滤日志行…" />
      <select v-model="level" class="select" style="width: 110px">
        <option value="all">全部级别</option>
        <option value="error">只看错误</option>
        <option value="warn">只看警告</option>
        <option value="info">只看信息</option>
      </select>
      <select v-model="since" class="select" style="width: 130px">
        <option value="all">全部时间</option>
        <option value="10">最近 10 分钟</option>
        <option value="30">最近 30 分钟</option>
        <option value="60">最近 1 小时</option>
        <option value="180">最近 3 小时</option>
      </select>
      <span v-if="activeFilter" class="badge">{{ matchCount }} 行匹配</span>
      <label class="row small muted" style="gap: 6px; cursor: pointer">
        <input v-model="auto" type="checkbox" /> 自动刷新
      </label>
    </div>
    <div class="row">
      <button class="btn sm ghost" @click="copy"><Icon name="copy" :size="14" /> 复制</button>
      <button class="btn sm" @click="load()">刷新</button>
    </div>
  </div>

  <Card flush>
    <div class="card-head">
      <div class="card-title">
        {{ name }}
        <span v-if="meta" class="dim">{{ meta.exists ? `${meta.count} 行` : '文件还不存在' }}</span>
      </div>
      <span class="mono muted small truncate" style="max-width: 60%">{{ current?.file }}</span>
    </div>
    <div ref="box" class="log-view">
      <pre v-if="filtered && !q.trim()" class="pre">{{ filtered }}</pre>
      <div v-else-if="filtered" class="pre log-lines">
        <div v-for="(parts, i) in highlighted" :key="i" class="log-line">
          <span v-for="(part, j) in parts" :key="j" :class="{ 'log-hit': part.hit }">{{ part.text }}</span>
        </div>
      </div>
      <div v-else class="empty">
        <span class="big-ico">📜</span>
        {{ text ? '没有匹配的行' : (meta?.exists === false ? '这个日志还没生成' : '还没有内容') }}
      </div>
    </div>
  </Card>
</template>
