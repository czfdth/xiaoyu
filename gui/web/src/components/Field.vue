<script setup>
defineProps({
  label: { type: String, default: '' },
  hint: { type: String, default: '' },
});
</script>

<template>
  <label class="field">
    <span v-if="label" class="label">{{ label }}</span>
    <slot />
    <span v-if="hint" class="hint">{{ hint }}</span>
  </label>
</template>
