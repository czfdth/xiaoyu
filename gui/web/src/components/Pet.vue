<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { get } from '../api.js';
import { store } from '../store.js';

const actions = ref([]);
const index = ref(0);
const bubble = ref(true);
const her = computed(() => store.overview?.her ?? { inner: {}, mood: {} });
const mood = computed(() => her.value.mood?.mood || her.value.inner?.mood || '');
const doing = computed(() => her.value.inner?.doing || '在发呆');

const MOOD_KEYWORDS = {
  高兴: ['舞', '抛接', '花', '鸽子', '宅', '唱'],
  开心: ['舞', '花', '环绕', '宅', '鸽子'],
  安静: ['代码', '魔方', '张望', '写', '读', '书'],
  困: ['睡', '小憩', '沉眠', '打盹', '枕'],
  累: ['睡', '小憩', '漂', '瘫'],
  饿: ['吃', '饭', '餐', '零食', '月饼', '冰淇淋', '汤圆', '西瓜'],
  想吃: ['吃', '饭', '餐', '零食', '月饼', '冰淇淋'],
  好奇: ['张望', '环绕', '花', '看', '鸽'],
  有点闷: ['张望', '漂', '发呆'],
  空落落: ['睡', '张望', '发呆'],
  别扭: ['偷吃', '张望'],
};

const current = computed(() => actions.value[index.value] || null);
const src = computed(() => (current.value ? `/api/pet/action/${encodeURIComponent(current.value.name)}` : ''));

function pool() {
  const keys = MOOD_KEYWORDS[mood.value] || [];
  const picked = actions.value.filter((a) => keys.some((k) => a.title.includes(k)));
  return picked.length ? picked : actions.value;
}

function pick() {
  const p = pool();
  if (!p.length) return;
  const next = p[Math.floor(Math.random() * p.length)];
  const idx = actions.value.findIndex((a) => a.name === next.name);
  index.value = idx >= 0 ? idx : 0;
}

async function load() {
  try {
    const r = await get('/pet/actions');
    actions.value = r.actions || [];
    pick();
  } catch { /* 没动作就不显示 */ }
}
onMounted(load);

let timer = null;
onMounted(() => { timer = setInterval(pick, 9000); });
onUnmounted(() => clearInterval(timer));

function poke() {
  bubble.value = !bubble.value;
  if (bubble.value) pick();
}
</script>

<template>
  <div v-if="current" class="pet-widget" :title="`${mood || '她'} · ${doing}`" @click="poke">
    <div v-if="bubble" class="pet-bubble">
      <b>{{ mood || '她' }}</b>
      <span>{{ doing }}</span>
    </div>
    <img :src="src" :alt="current.title" class="pet-img" />
    <div class="pet-caption">{{ current.title }}</div>
  </div>
</template>
