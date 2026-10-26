<script setup>
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from 'vue';
import { get } from '../api.js';
import { toast, toastError } from '../store.js';
import Card from '../components/Card.vue';
import Icon from '../components/Icon.vue';

const files = ref([]);
const name = ref('bridge');
const lines = ref(200);
const auto = ref(true);
const text = ref('');
const meta = ref(null);
const box = ref(null);
let timer = null;

const current = computed(() => files.value.find((f) => f.name === name.value));

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
    await navigator.clipboard.writeText(text.value);
    toast('已复制');
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
      <pre v-if="text" class="pre">{{ text }}</pre>
      <div v-else class="empty">
        <span class="big-ico">📜</span>
        {{ meta?.exists === false ? '这个日志还没生成' : '还没有内容' }}
      </div>
    </div>
  </Card>
</template>
