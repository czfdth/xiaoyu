<script setup>
defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
});
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'grid'">
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" />
    </template>
    <path v-else-if="name === 'heart'" d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z" />
    <g v-else-if="name === 'book'">
      <path d="M4 4.5h5.5A2.5 2.5 0 0 1 12 7v13a2.5 2.5 0 0 0-2.5-2.5H4z" />
      <path d="M20 4.5h-5.5A2.5 2.5 0 0 0 12 7v13a2.5 2.5 0 0 1 2.5-2.5H20z" />
    </g>
    <g v-else-if="name === 'id'">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10.5" r="1.8" />
      <path d="M5.8 15.6a3 3 0 0 1 2.7-1.9h.2a3 3 0 0 1 2.7 1.9M14.5 10h4M14.5 14h4" />
    </g>
    <g v-else-if="name === 'gear'">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.1M12 19.1v2.1M4.5 4.5l1.5 1.5M18 18l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.5 19.5 6 18M18 6l1.5-1.5" />
    </g>
    <g v-else-if="name === 'terminal'">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7.5 9.5 11 12l-3.5 2.5M13 14.5h4" />
    </g>
    <g v-else-if="name === 'life'">
      <path d="M12 21v-7" />
      <path d="M12 14c0-3.3 2.3-6 5.5-6 0 3.3-2.3 6-5.5 6z" />
      <path d="M12 14c0-3.3-2.3-6-5.5-6 0 3.3 2.3 6 5.5 6z" />
      <path d="M7.5 21h9" />
    </g>
    <path v-else-if="name === 'spark'" d="M12 3.2 14 9l5.8 1.6-4.6 3.4 1.4 6.1L12 16.7 7.4 20l1.4-6.1L4.2 10.6 10 9z" />
    <path v-else-if="name === 'refresh'" d="M20 11a8 8 0 1 0-2.4 5.7M20 5v6h-6" />
    <path v-else-if="name === 'play'" d="M8 5.5v13l10-6.5z" />
    <path v-else-if="name === 'stop'" d="M7 7h10v10H7z" />
    <path v-else-if="name === 'save'" d="M5 4h11l3 3v13H5zM8 4v6h7V4M8 20v-6h8v6" />
    <path v-else-if="name === 'copy'" d="M9 9h10v12H9zM5 15V3h10" />
    <path v-else d="M12 4v16M4 12h16" />
  </svg>
</template>
