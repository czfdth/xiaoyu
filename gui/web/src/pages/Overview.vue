<script setup>
import { computed, onMounted, ref } from 'vue';
import { store, refreshOverview, toast, toastError, fmtClock } from '../store.js';
import { get, post } from '../api.js';
import Card from '../components/Card.vue';
import StatusDot from '../components/StatusDot.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';

const o = computed(() => store.overview);
const ports = computed(() => o.value?.ports ?? {});
const caps = computed(() => o.value?.capabilities ?? {});
const her = computed(() => o.value?.her ?? { inner: {}, body: {}, mood: {} });
const counts = computed(() => o.value?.counts ?? {});
const dsh = computed(() => o.value?.dsh ?? null);
const snow = computed(() => o.value?.snowluma ?? {});
const gwAsk = ref(false);
const gwBusy = ref(false);
const dshText = computed(() => {
  if (!dsh.value) return '未知';
  if (dsh.value.ok) return '在线';
  if (dsh.value.reason === 'not-configured') return '没填地址';
  if (dsh.value.reason === 'unauthorized') return '要鉴权';
  return '连不上';
});

const PORT_ROWS = [
  { key: 'gateway', name: 'QQ 网关', note: 'SnowLuma' },
  { key: 'gatewayWs', name: 'QQ WebSocket', note: 'OneBot WS' },
  { key: 'tts', name: '声音', note: 'GPT-SoVITS' },
  { key: 'comfyui', name: '画图', note: 'ComfyUI' },
  { key: 'bridge', name: '大脑', note: 'bridge' },
];

const ENGINE_ROWS = computed(() => {
  const e = o.value?.engines ?? {};
  return [
    { key: 'snowluma', label: 'QQ 网关', path: e.snowluma?.home, extra: e.snowluma?.launcher },
    { key: 'gptSovits', label: '声音', path: e.gptSovits?.home, extra: e.gptSovits?.python },
    { key: 'comfyui', label: '画图', path: e.comfyui?.home, extra: e.comfyui?.python },
    { key: 'rvc', label: '唱歌', path: e.rvc?.home, extra: e.rvc?.python },
    { key: 'aiVoice', label: '唱歌管线', path: e.aiVoice?.home, extra: e.aiVoice?.singPipeline },
    { key: 'ffmpeg', label: 'ffmpeg', path: e.ffmpeg?.exe, extra: '' },
  ];
});

const pending = ref(null);
const running = ref('');
const pet = ref({ running: false });
const petBusy = ref(false);

async function loadPet() {
  try { pet.value = await get('/desktop-pet'); } catch { pet.value = { running: false }; }
}
onMounted(loadPet);

async function togglePet() {
  if (petBusy.value) return;
  petBusy.value = true;
  try {
    const r = pet.value.running ? await post('/desktop-pet/stop') : await post('/desktop-pet/start');
    if (r.error) toast(r.error, 'err', 5200); else toast(r.running === false ? '桌宠已收回' : '桌宠已放到桌面', 'ok');
    await loadPet();
  } catch (e) {
    toastError(e);
  } finally {
    petBusy.value = false;
  }
}
const output = ref('');
const outOpen = ref(false);

const ACTIONS = [
  { name: 'start', label: '启动全部', icon: 'play', kind: 'primary', hint: '按依赖顺序拉起探测到的引擎，最后起大脑' },
  { name: 'restart', label: '重启大脑', icon: 'refresh', kind: '', hint: '改完配置后用这个，几秒钟' },
  { name: 'stop', label: '停止大脑', icon: 'stop', kind: 'danger', hint: '只停 bridge，网关和引擎不动' },
];

async function run(name) {
  const action = ACTIONS.find((a) => a.name === name);
  pending.value = null;
  running.value = name;
  try {
    const r = await post(`/actions/${name}`);
    output.value = r.output || '（没有输出）';
    outOpen.value = true;
    toast(r.ok ? `${action.label}：完成` : `${action.label}：失败`, r.ok ? 'ok' : 'err');
    await refreshOverview({ silent: true });
  } catch (error) {
    toastError(error);
  } finally {
    running.value = '';
  }
}

function openWebui() {
  if (snow.value?.webuiUrl) window.open(snow.value.webuiUrl, '_blank', 'noopener');
  else toast('没探测到 SnowLuma 的 WebUI 端口（5099/5100）', 'warn');
}

function openLogin() {
  openWebui();
  gwAsk.value = false;
}

async function doStartGateway() {
  gwBusy.value = true;
  try {
    if (!snow.value?.installed) {
      if (snow.value?.downloadUrl) { window.open(snow.value.downloadUrl, '_blank', 'noopener'); gwAsk.value = false; }
      else toast('没配置下载地址，请自行下载 SnowLuma 并同意 EULA', 'warn');
      return;
    }
    const r = await post('/gateway/start', { confirm: true });
    gwAsk.value = false;
    if (r.reason === 'waiting-login') {
      toast('SnowLuma 已经开着，只是还没登录——去登录页扫码', 'warn');
      if (r.webuiUrl) window.open(r.webuiUrl, '_blank', 'noopener');
      return;
    }
    toast(r.started ? '已打开 SnowLuma，扫码登录后网关会上线' : '它已经在跑了', 'ok');
    setTimeout(() => refreshOverview({ silent: true }), 1800);
  } catch (error) {
    toastError(error);
  } finally {
    gwBusy.value = false;
  }
}
</script>

<template>
  <div v-if="store.overviewError" class="banner err">
    <span>⛔</span>
    <div>
      <b>连不上后端</b>
      <div class="small" style="margin-top: 2px">{{ store.overviewError }}</div>
      <button class="btn sm" style="margin-top: 8px" @click="refreshOverview()">重试</button>
    </div>
  </div>
  <div v-else-if="!o" class="empty"><span class="big-ico">🐋</span>正在读她的状态…</div>

  <template v-else>
    <div v-if="dsh && !dsh.ok" class="banner err">
      <span>🧠</span>
      <div>
        <b>大脑（DSH）没连上 —— 她现在不会回消息</b>
        <div class="small" style="margin-top: 2px">
          {{ dshText }}<span v-if="dsh.baseUrl"> · {{ dsh.baseUrl }}</span>
          <span v-if="dsh.registration && !dsh.registration.registered"> · DSH 里还没注册小鱼的工具</span>
        </div>
        <RouterLink to="/setup" class="btn sm" style="margin-top: 8px">去修</RouterLink>
      </div>
    </div>

    <div v-if="o.config.warnings.length" class="banner warn">
      <span>⚠️</span>
      <div>
        <b>还差几项没配好</b>
        <ul><li v-for="w in o.config.warnings" :key="w">{{ w }}</li></ul>
        <RouterLink to="/setup" class="btn sm" style="margin-top: 8px">去设置</RouterLink>
      </div>
    </div>

    <div class="grid cols-2" style="grid-template-columns: 1.5fr 1fr">
      <Card title="她此刻" :dim="her.role ? `人格卡：${her.role}` : ''">
        <template #actions>
          <span v-if="her.mood.mood" class="badge brand">心情 · {{ her.mood.mood }}</span>
        </template>
        <div class="stack">
          <div>
            <div class="label">在做</div>
            <div class="big" style="font-size: 18px">{{ her.inner.doing || '没在做什么' }}</div>
          </div>
          <div class="grid cols-2">
            <div>
              <div class="label">心里在想</div>
              <div class="dim">{{ her.inner.thinking || '—' }}</div>
            </div>
            <div>
              <div class="label">惦记着</div>
              <div class="dim">{{ her.inner.worrying || '—' }}</div>
            </div>
          </div>
          <div>
            <div class="label">身体</div>
            <div class="dim">{{ her.body.note || '没什么特别的感觉' }}</div>
          </div>
          <div style="border-top: 1px solid var(--line-soft); padding-top: 12px">
            <div class="label">最后一句</div>
            <div v-if="o.journal.last" class="dim">
              {{ o.journal.last.text }}
              <span class="muted small">· {{ fmtClock(o.journal.last.t) }}</span>
            </div>
            <div v-else class="muted">今天还没说话</div>
          </div>
        </div>
      </Card>

      <div class="stack">
        <Card title="产出" tight>
          <div class="grid cols-2" style="gap: 10px">
            <div class="stat"><div class="n">{{ counts.diary ?? 0 }}</div><div class="k">日记</div></div>
            <div class="stat"><div class="n">{{ counts.memoir ?? 0 }}</div><div class="k">回忆录</div></div>
            <div class="stat"><div class="n">{{ counts.dreams ?? 0 }}</div><div class="k">梦</div></div>
            <div class="stat"><div class="n">{{ counts.fantasies ?? 0 }}</div><div class="k">幻想</div></div>
          </div>
        </Card>

        <Card title="开关" tight>
          <div class="stack" style="gap: 8px">
            <button
              v-for="a in ACTIONS" :key="a.name"
              class="btn" :class="a.kind" :disabled="Boolean(running)"
              :title="a.hint" @click="pending = a"
            >
              <Icon :name="a.icon" :size="15" />
              {{ running === a.name ? '执行中…' : a.label }}
            </button>
          </div>
          <div class="hint" style="margin-top: 10px">动作走的是 bin/ 里的脚本，和双击 .bat 一样。</div>
          <div class="row spread" style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,.06); padding-top: 10px">
            <span class="small">
              桌宠
              <span class="dot" :class="pet.running ? 'ok' : 'idle'" />
              {{ pet.running ? '在桌面' : '没开' }}
            </span>
            <button class="btn sm" :disabled="petBusy" @click="togglePet">{{ pet.running ? '收回' : '放到桌面' }}</button>
          </div>
        </Card>
      </div>
    </div>

    <Card title="服务" dim="本机回环端口">
      <div class="grid cols-5">
        <div v-for="p in PORT_ROWS" :key="p.key" class="stat" style="display: flex; flex-direction: column; gap: 6px">
          <div class="row" style="gap: 8px">
            <span class="dot" :class="ports[p.key] ? 'ok' : 'bad'" />
            <b style="font-size: 13px">{{ p.name }}</b>
          </div>
          <div class="row spread">
            <span class="mono muted">{{ o.portNames[p.key] }}</span>
            <span class="badge" :class="ports[p.key] ? 'ok' : 'err'">{{ ports[p.key] ? '在线' : '离线' }}</span>
          </div>
          <div class="muted small">
            {{ p.key === 'gateway' && o.gateway?.ok
              ? `${o.gateway.nickname || '已登录'} · ${o.gateway.uin}`
              : (p.key === 'gateway' && snow.waitingLogin ? '已启动，待扫码登录' : p.note) }}
          </div>
          <button
            v-if="p.key === 'gateway' && !ports.gateway && snow.waitingLogin"
            class="btn sm"
            style="margin-top: 2px; align-self: flex-start"
            @click="openWebui"
          >
            打开登录页
          </button>
          <button
            v-else-if="p.key === 'gateway' && !ports.gateway"
            class="btn sm"
            style="margin-top: 2px; align-self: flex-start"
            @click="gwAsk = true"
          >
            {{ snow.installed ? '启动 SnowLuma' : '怎么装网关' }}
          </button>
        </div>
      </div>

      <div class="row" style="margin-top: 12px">
        <span class="pill">
          <span class="dot" :class="dsh?.ok ? 'ok' : 'bad'" />
          <b>大脑 DSH</b>
          <span class="mono muted">{{ dsh?.baseUrl || '未配置' }}</span>
        </span>
        <span class="badge" :class="dsh?.ok ? 'ok' : 'err'">{{ dshText }}</span>
        <span v-if="dsh?.registration" class="badge" :class="dsh.registration.registered ? 'ok' : 'warn'">
          {{ dsh.registration.registered ? `已注册 · ${dsh.registration.profile}` : '工具未注册' }}
        </span>
        <RouterLink to="/setup" class="btn sm ghost">检测 / 修</RouterLink>
      </div>
    </Card>

    <div class="grid cols-2">
      <Card title="能力">
        <div class="row">
          <span class="pill"><span class="dot" :class="caps.snowluma ? 'ok' : 'bad'" /><b>接 QQ</b></span>
          <span class="pill"><span class="dot" :class="caps.voice ? 'ok' : 'bad'" /><b>说话</b></span>
          <span class="pill"><span class="dot" :class="caps.draw ? 'ok' : 'bad'" /><b>画图</b></span>
          <span class="pill"><span class="dot" :class="caps.sing ? 'ok' : 'bad'" /><b>唱歌</b></span>
          <span class="pill"><span class="dot" :class="caps.ffmpeg ? 'ok' : 'bad'" /><b>动图</b></span>
        </div>
        <div class="hint" style="margin-top: 12px">
          能力是按「装没装 / 跑没跑」探测出来的；没装的能力，她的工具里也不会出现。
        </div>
      </Card>

      <Card title="引擎路径" dim="探测结果">
        <template #actions><RouterLink to="/config" class="btn sm ghost">去改</RouterLink></template>
        <div class="stack" style="gap: 9px">
          <div v-for="e in ENGINE_ROWS" :key="e.key" class="row spread" style="gap: 12px">
            <div class="row" style="gap: 8px; min-width: 96px">
              <span class="dot" :class="e.path ? 'ok' : 'idle'" />
              <span class="small">{{ e.label }}</span>
            </div>
            <div class="mono truncate muted" style="flex: 1; text-align: right" :title="e.path || ''">
              {{ e.path || '没找到' }}
            </div>
          </div>
        </div>
      </Card>
    </div>

    <Modal :open="Boolean(pending)" title="确认" @update:open="pending = null">
      <p style="margin: 0">{{ pending?.label }}：{{ pending?.hint }}？</p>
      <template #footer>
        <button class="btn ghost" @click="pending = null">算了</button>
        <button class="btn primary" @click="run(pending.name)">执行</button>
      </template>
    </Modal>

    <Modal :open="gwAsk" title="QQ 网关（SnowLuma）" @update:open="gwAsk = $event">
      <template v-if="snow.installed">
        <p v-if="snow.waitingLogin" style="margin: 0 0 8px">
          SnowLuma <b>已经开着</b>（WebUI {{ snow.webuiUrl }}），但还没登录，所以 OneBot 的 3000/3001 不会监听。
          <b>去登录页扫码/登录</b>，登录成功后网关会自动上线。
        </p>
        <p v-else style="margin: 0 0 8px">SnowLuma 是第三方 OneBot 网关，程序不会替你安装，也不会在后台静默启动它。</p>
        <p style="margin: 0 0 8px">
          点「打开」只会运行你已经装好的
          <span class="mono">{{ snow.launcher }}</span>；
          <b>扫码登录仍然要你自己完成</b>。
        </p>
        <p class="muted small" style="margin: 0">
          版本 {{ snow.version || '未知' }} · 使用前请阅读并同意它的 EULA（账号风险自担）。
        </p>
      </template>
      <template v-else>
        <p style="margin: 0 0 8px">没检测到 SnowLuma（<span class="mono">{{ snow.home }}</span>）。</p>
        <p style="margin: 0 0 8px">
          它不能随本程序分发（EULA 2.2 / 5.4），需要你自己下载并同意 EULA；
          装好后把路径填进「配置 → engines.snowluma.home」，或重新跑一次部署。
        </p>
        <p class="muted small" style="margin: 0">
          商业分发需作者书面授权：motricseven@foxmail.com
        </p>
      </template>
      <template #footer>
        <button class="btn ghost" @click="gwAsk = false">取消</button>
        <button v-if="snow.waitingLogin" class="btn primary" @click="openLogin">打开登录页</button>
        <button v-else class="btn primary" :disabled="gwBusy" @click="doStartGateway">
          {{ snow.installed ? '打开 SnowLuma' : '去下载页' }}
        </button>
      </template>
    </Modal>

    <Modal :open="outOpen" :title="`执行输出`" @update:open="outOpen = false">
      <pre class="pre" style="max-height: 46vh">{{ output }}</pre>
      <template #footer>
        <button class="btn" @click="outOpen = false">关闭</button>
      </template>
    </Modal>
  </template>
</template>
