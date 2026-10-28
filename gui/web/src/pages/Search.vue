<script setup>
// 第 1 步：先只证明"这个页面能被打开"。
// 刻意不 import 任何东西（不接 api.js），这样万一白屏，问题一定在路由/导航。
import { ref } from 'vue';

const q = ref('');
</script>

<template>
  <div class="stack" style="gap: 16px">
    <div class="row" style="gap: 8px">
      <input v-model="q" class="input" style="flex: 1" placeholder="搜她说过的话、记住的事、写过的日记…" />
      <button class="btn primary" disabled>搜索（下一步接上）</button>
    </div>
    <div class="muted small">页面已就位。下一步接上 /api/search，就能真的搜了。</div>
  </div>
</template>