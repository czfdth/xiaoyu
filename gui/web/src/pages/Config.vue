<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { get, post, put } from '../api.js';
import { store, refreshOverview, toast, toastError } from '../store.js';
import Card from '../components/Card.vue';
import Field from '../components/Field.vue';
import TagInput from '../components/TagInput.vue';

const meta = ref({ file: '', exists: false, hasToken: false, warnings: [] });

// 系统体检：密钥 / 备份可恢复性 / 语义检索召回 / 磁盘占用
const ops = ref(null);
const opsBusy = ref('');

async function loadOps() {
  try { ops.value = await get('/ops'); } catch { /* 体检读不到不影响配置页 */ }
}

async function runOpsTask(task) {
  if (opsBusy.value) return;
  opsBusy.value = task;
  try {
    const r = await post('/ops/run', { task });
    ops.value = r.health;
    const label = task === 'drill' ? '备份演练' : task === 'index' ? '索引体检' : '密钥扫描';
    toast(`已跑完：${label}`);
  } catch (e) { toastError(e); } finally { opsBusy.value = ''; }
}

async function cleanupDryRun() {
  try {
    const r = await post('/ops/cleanup', { dryRun: true });
    toast(r.removed.length
      ? `可清理 ${r.removed.length} 个文件，约 ${r.mb} MB（演练，未删除）`
      : '没有需要清理的旧备份/旧日志');
  } catch (e) { toastError(e); }
}

function mb(v) {
  const n = Number(v) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`;
}

// 说说（Qzone 自动发）设置
const qzone = ref(null);
const qzoneForm = reactive({ probability: 0.5, maxPerDay: 3, minGapHours: 6, quietStartHour: 0, quietEndHour: 8, enabled: true });
const savingQzone = ref(false);

async function loadQzone() {
  try {
    const r = await get('/qzone');
    qzone.value = r;
    Object.assign(qzoneForm, r);
  } catch { /* 读不到不影响页面 */ }
}

async function saveQzone() {
  if (savingQzone.value) return;
  savingQzone.value = true;
  try {
    const r = await post('/qzone', {
      enabled: qzoneForm.enabled,
      probability: Number(qzoneForm.probability),
      maxPerDay: Number(qzoneForm.maxPerDay),
      minGapHours: Number(qzoneForm.minGapHours),
      quietStartHour: Number(qzoneForm.quietStartHour),
      quietEndHour: Number(qzoneForm.quietEndHour),
    });
    qzone.value = r.qzone;
    toast('说说设置已保存，下一次任务触发就生效');
  } catch (e) { toastError(e); } finally { savingQzone.value = false; }
}

// 手机访问（局域网 + 口令）
const remote = ref(null);
const remoteForm = reactive({ password: '', port: 8765, allowWrite: false });
const savingRemote = ref(false);

async function loadRemote() {
  try {
    remote.value = await get('/remote');
    Object.assign(remoteForm, { port: remote.value.port, allowWrite: remote.value.allowWrite });
  } catch { /* 读不到不影响配置页 */ }
}

async function saveRemote(enabled) {
  if (savingRemote.value) return;
  savingRemote.value = true;
  try {
    const payload = { enabled, port: Number(remoteForm.port) || 8765, allowWrite: remoteForm.allowWrite === true };
    if (remoteForm.password) payload.password = remoteForm.password;
    const r = await post('/remote', payload);
    remote.value = r.remote;
    remoteForm.password = '';
    toast(r.restartHint || '已保存', 'ok', 6000);
  } catch (e) { toastError(e); } finally { savingRemote.value = false; }
}

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

const avatar = ref('');
const avatarOptions = ref([]);
const avatarBusy = ref(false);

async function loadAvatar() {
  try {
    const r = await get('/works/avatar-options');
    avatar.value = r.current || '';
    avatarOptions.value = r.options || [];
  } catch { /* 头像接口没起不影响配置页 */ }
}

async function chooseAvatar(name) {
  if (!name || name === avatar.value || avatarBusy.value) return;
  avatarBusy.value = true;
  try {
    await post('/ui/avatar', { name });
    avatar.value = name;
    toast('头像已换', 'ok');
  } catch (e) { toastError(e); } finally { avatarBusy.value = false; }
}
onMounted(loadAvatar);
onMounted(loadOps);
onMounted(loadRemote);
onMounted(loadQzone);

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

    <Card title="控制台头像" dim="点一张就换">
      <div class="row" style="gap: 16px; align-items: flex-start; flex-wrap: wrap">
        <div style="text-align: center; min-width: 82px">
          <img
            v-if="avatar"
            :src="`/api/works/image/${encodeURIComponent(avatar)}`"
            alt="当前头像"
            style="width: 72px; height: 72px; border-radius: 18px; object-fit: cover; border: 1px solid var(--border); box-shadow: 0 0 18px rgba(79, 209, 197, .16)"
          />
          <div class="hint small" style="margin-top: 6px; max-width: 120px; word-break: break-all">{{ avatar || '默认' }}</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap; max-width: 680px">
          <button
            v-for="o in avatarOptions"
            :key="o.name"
            class="avatar-pick"
            :class="{ active: o.name === avatar }"
            :title="o.name"
            :disabled="avatarBusy"
            @click="chooseAvatar(o.name)"
          >
            <img :src="o.url" :alt="o.name" style="width: 48px; height: 48px; object-fit: cover; border-radius: 12px" />
          </button>
        </div>
      </div>
      <div class="hint" style="margin-top: 8px">换完立刻生效；记在 config.json 的 ui.avatar，下次打开还是这张。</div>
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

    <Card title="说说（QQ 空间）" :dim="qzone ? `概率 ${Math.round(qzone.probability * 100)}% · 每天最多 ${qzone.maxPerDay} 条` : '读取中…'">
      <div class="stack" style="gap: 12px">
        <div class="hint">
          每半小时有一次机会，按概率决定发不发；再受「每天上限」和「最小间隔」约束。
          改完不用重启，下一次任务触发就按新值走。
        </div>
        <label class="stack" style="gap: 4px">
          <span class="muted small">放行概率 {{ Math.round(qzoneForm.probability * 100) }}%（越高越常发）</span>
          <input v-model.number="qzoneForm.probability" type="range" min="0.05" max="1" step="0.05" />
        </label>
        <div class="row" style="gap: 12px; flex-wrap: wrap">
          <label class="stack" style="gap: 4px">
            <span class="muted small">每天最多</span>
            <input v-model.number="qzoneForm.maxPerDay" class="input" type="number" min="1" max="10" style="width: 90px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">最小间隔（小时）</span>
            <input v-model.number="qzoneForm.minGapHours" class="input" type="number" min="1" max="24" style="width: 110px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">免打扰 从</span>
            <input v-model.number="qzoneForm.quietStartHour" class="input" type="number" min="0" max="23" style="width: 80px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">到</span>
            <input v-model.number="qzoneForm.quietEndHour" class="input" type="number" min="0" max="23" style="width: 80px" />
          </label>
          <label class="row" style="gap: 6px; align-items: center; margin-top: 16px">
            <input v-model="qzoneForm.enabled" type="checkbox" />
            <span class="small">启用自动发</span>
          </label>
        </div>
        <div class="row">
          <button class="btn primary sm" :disabled="savingQzone" @click="saveQzone">{{ savingQzone ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </Card>

    <Card title="手机访问" :dim="remote?.enabled ? '已开启' : '默认关闭'">
      <div class="stack" style="gap: 10px">
        <div class="hint">
          默认只绑 127.0.0.1，手机打不开。开启后会绑到 0.0.0.0，<b>必须设口令</b>
          （至少 12 位，scrypt 哈希存本机），且<b>默认只读</b>：手机能看，改不了配置。
        </div>
        <div class="row" style="gap: 12px; flex-wrap: wrap; align-items: flex-end">
          <label class="stack" style="gap: 4px">
            <span class="muted small">访问口令（至少 12 位）</span>
            <input v-model="remoteForm.password" class="input" type="password" placeholder="留空 = 不改口令" style="width: 220px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">端口</span>
            <input v-model.number="remoteForm.port" class="input" type="number" min="1024" max="65535" style="width: 110px" />
          </label>
          <label class="row" style="gap: 6px; align-items: center">
            <input v-model="remoteForm.allowWrite" type="checkbox" />
            <span class="small">允许远程写入（不建议）</span>
          </label>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="btn primary sm" :disabled="savingRemote" @click="saveRemote(true)">
            {{ savingRemote ? '保存中…' : '保存并开启' }}
          </button>
          <button class="btn sm ghost" :disabled="savingRemote || !remote?.enabled" @click="saveRemote(false)">关闭手机访问</button>
          <span v-if="remote?.lan?.length" class="muted small">
            手机访问：<span v-for="ip in remote.lan" :key="ip" class="mono">http://{{ ip }}:{{ remote.port }}</span>
          </span>
        </div>
        <div class="hint">改完重启控制台才生效。口令忘了就在这台电脑上重设一次。</div>
      </div>
    </Card>

    <Card title="系统体检" :dim="ops ? '密钥 · 备份 · 检索 · 磁盘' : '读取中…'">
      <div class="stack" style="gap: 10px">
        <div class="row spread" style="gap: 10px; flex-wrap: wrap">
          <span class="row" style="gap: 8px">
            <i class="dot" :style="{ background: ops?.keys?.ok ? 'var(--ok)' : 'var(--warn)' }" />
            <b>密钥</b>
            <span class="muted small">
              {{ ops?.keys?.ok ? '没有明文密钥' : (ops?.keys?.plaintextFiles?.length ? '明文在 ' + ops.keys.plaintextFiles.map((f) => f.split('\\').pop()).join('、') : '待检查') }}
            </span>
            <span v-if="ops?.keys?.logLeaks?.length" class="badge warn">日志里 {{ ops.keys.logLeaks.length }} 处</span>
          </span>
          <button class="btn sm ghost" :disabled="!!opsBusy" @click="runOpsTask('keys')">
            {{ opsBusy === 'keys' ? '扫描中…' : '重扫' }}
          </button>
        </div>

        <div class="row spread" style="gap: 10px; flex-wrap: wrap">
          <span class="row" style="gap: 8px">
            <i class="dot" :style="{ background: ops?.drill ? (ops.drill.ok ? 'var(--ok)' : 'var(--err)') : 'var(--muted)' }" />
            <b>备份</b>
            <span class="muted small">
              {{ ops?.drill ? (ops.drill.ok ? '可恢复：' + ops.drill.backup + '，' + ops.drill.journalRows + ' 条聊天记录' : '演练失败：' + ops.drill.reason) : '还没演练过' }}
            </span>
          </span>
          <button class="btn sm ghost" :disabled="!!opsBusy" @click="runOpsTask('drill')">
            {{ opsBusy === 'drill' ? '解压中…' : '演练一次' }}
          </button>
        </div>

        <div class="row spread" style="gap: 10px; flex-wrap: wrap">
          <span class="row" style="gap: 8px">
            <i class="dot" :style="{ background: ops?.index ? (ops.index.ok ? 'var(--ok)' : 'var(--warn)') : 'var(--muted)' }" />
            <b>语义检索</b>
            <span class="muted small">
              {{ ops?.index ? (ops.index.ok ? '召回 ' + Math.round((ops.index.rate || 0) * 100) + '%（' + ops.index.hits + '/' + ops.index.samples + '），共 ' + ops.index.entries + ' 条' : (ops.index.reason || '未通过')) : '还没体检过' }}
            </span>
          </span>
          <button class="btn sm ghost" :disabled="!!opsBusy" @click="runOpsTask('index')">
            {{ opsBusy === 'index' ? '抽样中…' : '体检一次' }}
          </button>
        </div>

        <div class="row spread" style="gap: 10px; flex-wrap: wrap">
          <span class="row" style="gap: 8px">
            <i class="dot" style="background: var(--brand)" />
            <b>磁盘</b>
            <span class="muted small">
              数据 {{ mb(ops?.disk?.home?.mb) }}（state {{ mb(ops?.disk?.state?.mb) }} · 备份 {{ mb(ops?.disk?.backups?.mb) }} · 日志 {{ mb(ops?.disk?.logs?.mb) }}）
              <span v-if="ops?.disk?.free">，剩余 {{ ops.disk.free }} GB</span>
            </span>
          </span>
          <button class="btn sm ghost" @click="cleanupDryRun">清理演练</button>
        </div>

        <div class="hint">
          恢复演练会真的把最新备份解开、校验 JSON 和聊天记录条数（跑完自动删临时目录）。
          清理只动 30 天前的备份 zip 和 14 天前的日志，<b>不会碰 state 里的记忆</b>。
        </div>
      </div>
    </Card>
  </template>
</template>
