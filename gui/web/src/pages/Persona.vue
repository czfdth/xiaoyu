<script setup>
import { computed, onMounted, ref } from 'vue';
import { get, put } from '../api.js';
import { toast, toastError, fmtTime } from '../store.js';
import Card from '../components/Card.vue';

const roles = ref([]);
const active = ref('');
const content = ref('');
const saved = ref('');
const loading = ref(false);
const saving = ref(false);

const dirty = computed(() => content.value !== saved.value);
const chars = computed(() => content.value.length);
const sections = computed(() => (content.value.match(/^#{1,6}\s+/gm) ?? []).length);

async function loadList() {
  try {
    const r = await get('/roles');
    roles.value = r.roles ?? [];
    const pick = roles.value.find((x) => x.active) ?? roles.value[0];
    if (pick) await open(pick.name);
  } catch (e) { toastError(e); }
}

async function open(name) {
  loading.value = true;
  try {
    const r = await get(`/roles/${encodeURIComponent(name)}`);
    active.value = r.name;
    content.value = r.content;
    saved.value = r.content;
  } catch (e) { toastError(e); } finally { loading.value = false; }
}

async function save() {
  if (!dirty.value) return;
  saving.value = true;
  try {
    const r = await put(`/roles/${encodeURIComponent(active.value)}`, { content: content.value });
    saved.value = content.value;
    toast(`已保存（${r.chars} 字）${r.backup ? '，旧版留了备份' : ''}`);
  } catch (e) { toastError(e); } finally { saving.value = false; }
}

function revert() { content.value = saved.value; }

onMounted(loadList);
</script>

<template>
  <div class="split">
    <div class="side">
      <Card title="人格卡" :dim="`${roles.length} 张`" tight>
        <div class="list">
          <div
            v-for="r in roles" :key="r.name"
            class="list-item" :class="{ active: r.name === active }"
            @click="open(r.name)"
          >
            <div style="min-width: 0">
              <div class="t truncate">
                {{ r.name }}
                <span v-if="r.active" class="badge brand" style="margin-left: 6px">当前</span>
              </div>
              <div class="muted small">{{ r.chars }} 字 · {{ fmtTime(r.mtime) }}</div>
            </div>
          </div>
        </div>
      </Card>
      <div class="hint" style="padding: 0 4px">
        人格卡会在每条消息前注入。保存后下一条消息就生效，不用重启。
      </div>
    </div>

    <div>
      <Card :title="active || '编辑'" :dim="dirty ? '有未保存的修改' : '已保存'">
        <template #actions>
          <span class="badge">{{ chars }} 字</span>
          <span class="badge" :class="chars > 6000 ? 'warn' : ''">{{ sections }} 节</span>
          <button class="btn sm" :disabled="!dirty" @click="revert">还原</button>
          <button class="btn sm primary" :disabled="!dirty || saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </template>

        <div v-if="loading" class="empty">读取中…</div>
        <textarea
          v-else
          v-model="content"
          class="textarea code"
          style="min-height: 58vh"
          spellcheck="false"
          placeholder="这张卡是空的…"
        />
        <div class="hint" style="margin-top: 10px">
          默认注入上限 {{ 6000 }} 字（config.json 的 role.maxInjectChars）。她的口吻、边界、规矩都写在这里；
          写得越具体，她越像一个人。
        </div>
      </Card>
    </div>
  </div>
</template>
