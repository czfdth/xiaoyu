<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { get, post, put } from '../api.js';
import { store, refreshOverview, toast, toastError } from '../store.js';
import Card from '../components/Card.vue';
import Field from '../components/Field.vue';
import TagInput from '../components/TagInput.vue';

const meta = ref({ file: '', exists: false, hasToken: false, warnings: [] });
const form = reactive({
  ownerQQ: '',
  privateIds: [],
  groups: [],
  dshBaseUrl: '',
  dshProvider: '',
  dshModel: '',
  httpUrl: '',
  wsUrl: '',
  consolePort: '',
  engines: {},
});
const token = ref('');
const savedSnapshot = ref('');
const saving = ref(false);
const loading = ref(true);

const ENGINE_FIELDS = [
  { key: 'snowluma', label: 'SnowLuma 目录' },
  { key: 'gptSovits', label: 'GPT-SoVITS 目录' },
  { key: 'gptSovitsPython', label: 'GPT-SoVITS python' },
  { key: 'comfyui', label: 'ComfyUI 目录' },
  { key: 'comfyuiPython', label: 'ComfyUI python' },
  { key: 'aiVoice', label: 'ai-voice 目录' },
  { key: 'rvc', label: 'RVC 目录' },
  { key: 'rvcPython', label: 'RVC python' },
  { key: 'ffmpeg', label: 'ffmpeg.exe' },
];

const snapshot = computed(() => JSON.stringify({
  ownerQQ: String(form.ownerQQ ?? ''),
  privateIds: form.privateIds,
  groups: form.groups,
  dshBaseUrl: form.dshBaseUrl,
  dshProvider: form.dshProvider,
  dshModel: form.dshModel,
  httpUrl: form.httpUrl,
  wsUrl: form.wsUrl,
  consolePort: String(form.consolePort ?? ''),
  engines: form.engines,
  token: token.value,
}));

const dirty = computed(() => snapshot.value !== savedSnapshot.value);
const ownerInvalid = computed(() => Boolean(form.ownerQQ) && !/^\d{5,12}$/.test(String(form.ownerQQ)));

async function load() {
  loading.value = true;
  try {
    const c = await get('/config');
    meta.value = { file: c.file, exists: c.exists, hasToken: c.snowluma.hasToken, warnings: c.warnings };
    form.ownerQQ = c.ownerQQ ? String(c.ownerQQ) : '';
    form.privateIds = [...(c.allow.private ?? [])];
    form.groups = [...(c.allow.groups ?? [])];
    form.dshBaseUrl = c.dsh.baseUrl;
    form.dshProvider = c.dsh.provider;
    form.dshModel = c.dsh.model;
    form.httpUrl = c.snowluma.httpUrl;
    form.wsUrl = c.snowluma.wsUrl;
    form.consolePort = String(c.consolePort ?? '');
    form.engines = { ...(c.engines ?? {}) };
    token.value = '';
    savedSnapshot.value = snapshot.value;
  } catch (e) { toastError(e); } finally { loading.value = false; }
}

async function save() {
  if (ownerInvalid.value) { toast('ownerQQ 要是 5~12 位数字', 'err'); return; }
  saving.value = true;
  try {
    await put('/config', {
      ownerQQ: form.ownerQQ === '' ? null : String(form.ownerQQ),
      allow: { private: form.privateIds, groups: form.groups },
      dsh: { baseUrl: form.dshBaseUrl, provider: form.dshProvider, model: form.dshModel },
      snowluma: { httpUrl: form.httpUrl, wsUrl: form.wsUrl, accessToken: token.value },
      engines: { ...form.engines },
      consolePort: Number(form.consolePort) || undefined,
    });
    toast('配置已保存（旧版留了备份）');
    await Promise.all([load(), refreshOverview({ silent: true })]);
  } catch (e) { toastError(e); } finally { saving.value = false; }
}

function fillEngines() {
  const e = store.overview?.engines;
  if (!e) { toast('还没探测到引擎', 'info'); return; }
  form.engines = {
    ...form.engines,
    snowluma: e.snowluma?.home || '',
    gptSovits: e.gptSovits?.home || '',
    gptSovitsPython: e.gptSovits?.python || '',
    comfyui: e.comfyui?.home || '',
    comfyuiPython: e.comfyui?.python || '',
    aiVoice: e.aiVoice?.home || '',
    rvc: e.rvc?.home || '',
    rvcPython: e.rvc?.python || '',
    ffmpeg: e.ffmpeg?.exe || '',
  };
  toast('已按探测结果填好，记得保存', 'info');
}

onMounted(load);

const backups = ref([]);
const backupBusy = ref(false);

async function loadBackups() {
  try { const r = await get('/backups'); backups.value = r.backups || []; } catch { /* 面板没起 */ }
}
onMounted(loadBackups);

async function createBackup() {
  backupBusy.value = true;
  try {
    const r = await post('/backups');
    toast(`已备份：${r.backups?.[0]?.name || '完成'}`, 'ok');
    await loadBackups();
  } catch (e) { toastError(e); } finally { backupBusy.value = false; }
}

async function restoreFrom(name) {
  if (!window.confirm(`用 ${name} 覆盖当前 state 并重启？当前 state 会先备份。`)) return;
  backupBusy.value = true;
  try {
    const r = await post('/backups/restore', { name });
    toast(`恢复完成：${r.file}`, 'ok', 5200);
  } catch (e) { toastError(e); } finally { backupBusy.value = false; }
}

</script>

<template>
  <div v-if="loading" class="empty">读取配置…</div>

  <template v-else>
    <div class="row spread" style="margin-bottom: 14px">
      <div class="mono muted small truncate" :title="meta.file">{{ meta.file }}</div>
      <div class="row">
        <button class="btn sm ghost" @click="load">重新读取</button>
        <button class="btn primary" :disabled="!dirty || saving" @click="save">
          {{ saving ? '保存中…' : dirty ? '保存修改' : '已保存' }}
        </button>
      </div>
    </div>

    <div v-if="meta.warnings.length" class="banner warn">
      <span>⚠️</span>
      <div>
        <b>还没配好的</b>
        <ul><li v-for="w in meta.warnings" :key="w">{{ w }}</li></ul>
      </div>
    </div>

    <Card title="主人与白名单" dim="她只回这些人">
      <div class="form-grid">
        <Field label="主人 QQ（ownerQQ）" hint="审批、管理命令、封闭模式只认这个号" :class="{ 'span-2': false }">
          <input v-model="form.ownerQQ" class="input mono" :class="{ invalid: ownerInvalid }" placeholder="例如 123456789" inputmode="numeric" />
        </Field>
        <Field label="控制台端口（bridge）" hint="默认 3100">
          <input v-model="form.consolePort" class="input mono" inputmode="numeric" />
        </Field>
        <Field label="允许私聊的 QQ" hint="回车添加；空 + 不开 allowAllWhenEmpty = 谁也不回">
          <TagInput v-model="form.privateIds" placeholder="输入 QQ 号后回车" />
        </Field>
        <Field label="允许的群号" hint="她只会进这些群">
          <TagInput v-model="form.groups" placeholder="输入群号后回车" />
        </Field>
      </div>
    </Card>

    <Card title="大脑（DSH）">
      <div class="form-grid">
        <Field label="DSH 地址" hint="DeepSeek Harness 的 Web API">
          <input v-model="form.dshBaseUrl" class="input mono" placeholder="http://127.0.0.1:3080" />
        </Field>
        <Field label="模型" hint="默认 deepseek-flash">
          <input v-model="form.dshModel" class="input mono" />
        </Field>
        <Field label="provider">
          <input v-model="form.dshProvider" class="input mono" />
        </Field>
      </div>
    </Card>

    <Card title="QQ 网关（SnowLuma）">
      <div class="form-grid">
        <Field label="OneBot HTTP" hint="发消息走这个">
          <input v-model="form.httpUrl" class="input mono" placeholder="http://127.0.0.1:3000" />
        </Field>
        <Field label="OneBot WebSocket" hint="收消息走这个">
          <input v-model="form.wsUrl" class="input mono" placeholder="ws://127.0.0.1:3001" />
        </Field>
        <Field class="span-2" label="accessToken" :hint="meta.hasToken ? '已经有 token；留空表示不改' : 'SnowLuma 里配的那个 token'">
          <input v-model="token" class="input mono" type="password" :placeholder="meta.hasToken ? '••••••（留空 = 不修改）' : '还没填'" autocomplete="new-password" />
        </Field>
      </div>
    </Card>

    <Card title="引擎路径" dim="留空则启动时自动探测">
      <template #actions>
        <button class="btn sm ghost" @click="fillEngines">用探测结果填充</button>
      </template>
      <div class="form-grid">
        <Field v-for="f in ENGINE_FIELDS" :key="f.key" :label="f.label">
          <input v-model="form.engines[f.key]" class="input mono" placeholder="留空 = 自动探测" />
        </Field>
      </div>
      <div class="hint" style="margin-top: 6px">
        优先级：环境变量 &gt; 这里填的 &gt; 常见安装位置 &gt; 包内 engines/。改完建议点「重启大脑」。
      </div>
    </Card>

    <Card title="备份与导出" :dim="`${backups.length} 份备份`">
      <template #actions>
        <button class="btn sm" :disabled="backupBusy" @click="createBackup">立即备份</button>
        <a class="btn sm ghost" href="/api/export/life.md">导出她的一生</a>
      </template>
      <div v-if="!backups.length" class="muted small">还没有备份。</div>
      <div v-for="b in backups" :key="b.name" class="row spread" style="padding: 5px 0; gap: 10px">
        <span class="mono small" style="flex: 1">{{ b.name }}</span>
        <span class="muted small">{{ (b.size / 1048576).toFixed(2) }} MB · {{ new Date(b.at).toLocaleString() }}</span>
        <a class="btn sm ghost" :href="`/api/backups/${encodeURIComponent(b.name)}/download`">下载</a>
        <button class="btn sm" :disabled="backupBusy" @click="restoreFrom(b.name)">恢复</button>
      </div>
      <div class="hint" style="margin-top: 6px">恢复会先停大脑、备份当前 state，再用选中的 zip 覆盖并重启。</div>
    </Card>

    <div class="row" style="justify-content: flex-end">
      <button class="btn ghost" :disabled="!dirty" @click="load">放弃修改</button>
      <button class="btn primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? '保存中…' : '保存修改' }}
      </button>
    </div>
  </template>
</template>
