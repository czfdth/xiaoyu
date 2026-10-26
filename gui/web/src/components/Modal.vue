<script setup>
defineProps({ open: Boolean, title: String });
defineEmits(['update:open']);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mask" @click.self="$emit('update:open', false)">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">{{ title }}</div>
        <div class="modal-body"><slot /></div>
        <div class="modal-foot"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>
