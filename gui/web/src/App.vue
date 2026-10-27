<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { store, refreshOverview } from './store.js';
import Toasts from './components/Toasts.vue';
import Icon from './components/Icon.vue';
import Pet from './components/Pet.vue';

const route = useRoute();
const title = computed(() => route.meta.title || '小鱼');
const sub = computed(() => route.meta.sub || '');
const bridgeUp = computed(() => Boolean(store.overview?.ports?.bridge));
const warningCount = computed(() => store.overview?.config?.warnings?.length ?? 0);
const alerts = computed(() => store.overview?.alerts ?? []);
const avatar = ref('');

async function loadAvatar() {
  try {
    const r = await fetch('/api/works/avatar');
    const d = await r.json();
    if (d?.url) avatar.value = d.url;
  } catch { /* 没有头像就用鲸鱼占位 */ }
}

const NAV = [
  { to: '/', icon: 'grid', label: '概览' },
  { to: '/her', icon: 'heart', label: '她' },
  { to: '/life', icon: 'life', label: '一生' },
  { to: '/works', icon: 'life', label: '画' },
  { to: '/memory', icon: 'book', label: '记忆' },
  { to: '/tools', icon: 'spark', label: '工具' },
  { to: '/spend', icon: 'coin', label: '花费' },
  { to: '/persona', icon: 'id', label: '人格卡' },
  { to: '/config', icon: 'gear', label: '配置' },
  { to: '/logs', icon: 'terminal', label: '日志' },
  { to: '/security', icon: 'shield', label: '安全' },
];

let timer = null;
onMounted(() => {
  refreshOverview();
  loadAvatar();
  timer = setInterval(() => { if (!document.hidden) refreshOverview({ silent: true }); }, 15000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <img v-if="avatar" class="brand-avatar" :src="avatar" alt="" />
        <span v-else class="brand-mark">🐋</span>
        <div>
          <div class="brand-name">小鱼管家</div>
          <div class="brand-sub">xiaoyu console</div>
        </div>
      </div>

      <nav class="nav">
        <RouterLink v-for="n in NAV" :key="n.to" :to="n.to" class="nav-item">
          <span class="ico"><Icon :name="n.icon" :size="16" /></span>
          <span>{{ n.label }}</span>
          <span v-if="n.to === '/config' && warningCount" class="badge warn" style="margin-left:auto">{{ warningCount }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <div class="row" style="gap: 7px; margin-bottom: 6px">
          <span class="dot" :class="bridgeUp ? 'ok' : 'bad'" />
          <span>{{ bridgeUp ? '大脑在线' : '大脑离线' }}</span>
        </div>
        <div class="root" :title="store.overview?.root">{{ store.overview?.root || '读取中…' }}</div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <div class="page-title">{{ title }}</div>
          <div class="page-sub">{{ sub }}</div>
        </div>
        <div class="row">
          <RouterLink v-if="warningCount" to="/setup" class="btn sm">先把它配好</RouterLink>
          <button class="btn sm ghost" :disabled="store.loadingOverview" @click="refreshOverview()">
            <Icon name="refresh" :size="14" /> 刷新
          </button>
        </div>
      </header>

      <div class="content">
        <div v-if="alerts.length" class="banner" :class="alerts[0].level === 'error' ? 'err' : 'warn'" style="margin-bottom: 12px">
          <span>{{ alerts[0].level === 'error' ? '⛔' : '⚠️' }}</span>
          <div>
            <b>{{ alerts[0].text }}</b>
            <div v-if="alerts.length > 1" class="small" style="margin-top: 2px">{{ alerts.slice(1).map((x) => x.text).join(' · ') }}</div>
          </div>
        </div>
        <RouterView />
      </div>
    </main>

    <Pet />
    <Toasts />
  </div>
</template>
