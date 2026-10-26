<script setup>
defineProps({
  title: { type: String, default: '' },
  dim: { type: String, default: '' },
  tight: Boolean,
  flush: Boolean,
});
</script>

<template>
  <section class="card">
    <header v-if="title || $slots.actions" class="card-head">
      <div class="card-title">
        {{ title }}<span v-if="dim" class="dim">{{ dim }}</span>
      </div>
      <div class="row"><slot name="actions" /></div>
    </header>
    <div class="card-body" :class="{ tight, flush }"><slot /></div>
  </section>
</template>
