<script setup>
import { ref } from 'vue';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  placeholder: { type: String, default: '输入后按回车添加' },
});
const emit = defineEmits(['update:modelValue']);
const draft = ref('');

function add() {
  const parts = draft.value.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  const next = [...props.modelValue];
  for (const p of parts) if (!next.includes(p)) next.push(p);
  emit('update:modelValue', next);
  draft.value = '';
}

function remove(value) {
  emit('update:modelValue', props.modelValue.filter((v) => v !== value));
}

function onKey(event) {
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault();
    add();
  } else if (event.key === 'Backspace' && !draft.value && props.modelValue.length) {
    remove(props.modelValue[props.modelValue.length - 1]);
  }
}
</script>

<template>
  <div class="tag-input">
    <span v-for="v in modelValue" :key="v" class="tag">
      {{ v }}
      <button type="button" title="移除" @click="remove(v)">×</button>
    </span>
    <input
      v-model="draft"
      :placeholder="modelValue.length ? '' : placeholder"
      inputmode="numeric"
      @keydown="onKey"
      @blur="add"
    />
  </div>
</template>
