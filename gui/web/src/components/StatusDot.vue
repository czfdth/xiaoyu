<script setup>
defineProps({
  ok: { type: Boolean, default: false },
  label: { type: String, default: '' },
  port: { type: [Number, String], default: '' },
  idle: Boolean,
});
</script>

<template>
  <div class="pill">
    <span class="dot" :class="idle ? 'idle' : (ok ? 'ok' : 'bad')" />
    <b>{{ label }}</b>
    <span v-if="port" class="mono muted">{{ port }}</span>
  </div>
</template>
