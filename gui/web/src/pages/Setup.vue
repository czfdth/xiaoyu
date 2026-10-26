<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, get, post } from '../api.js';
import { store, refreshOverview, toast, toastError } from '../store.js';
import Card from '../components/Card.vue';
import Field from '../components/Field.vue';
import TagInput from '../components/TagInput.vue';
import Icon from '../components/Icon.vue';

const router = useRouter();
const STEPS = ['主人', 'QQ 网关', '引擎', '完成'];
const step = ref(0);
const done = ref(false);
const saving = ref(false);
const hasToken = ref(false);

const pairing = ref({ paired: false, active: false, code: '', expiresAt: 0, attemptsLeft: 0 });
const dsh = ref(null);
const dshChecking = ref(false);
const now = ref(Date.now());
let pollTimer = null;
let tickTimer = null;

const remainText = computed(() => {
  const ms = Math.max(0, Number(pairing.value.expiresAt || 0) - now.value);
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
});
const gateway = computed(() => store.overview?.gateway ?? null);
const dshState = computed(() => dsh.value ?? store.overview?.dsh ?? null);
const dshText = computed(() => {
  const s = dshState.value;
  if (!s) return '未知';
  if (s.ok) return '在线';
  if (s.reason === 'not-configured') return '没填地址';
  if (s.reason === 'unauthorized') return '要鉴权';
  return '连不上';
});

async function checkDsh() {
  dshChecking.value = true;
  try {
    dsh.value = await get('/dsh');
    if (!dsh.value.ok) toast('没找到在跑的 DSH', 'err');
  } catch (e) { toastError(e); } finally { dshChecking.value = false; }
}

async function applyDsh() {
  if (!dsh.value?.baseUrl) return;
  try {
    await post('/dsh', { baseUrl: dsh.value.baseUrl });
    toast('已写入 dsh.baseUrl');
    await refreshOverview({ silent: true });
  } catch (e) { toastError(e); }
}

const form = reactive({
  ownerQQ: '',
  privateIds: [],
  groups: [],
  token: '',
  httpUrl: 'http://127.0.0.1:3000',
  dshBaseUrl: 'http://127.0.0.1:3080',
});

const caps = computed(() => store.overview?.capabilities ?? {});
const engines = computed(() => store.overview?.engines ?? {});
const ownerOk = computed(() => /^\d{5,12}$/.test(String(form.ownerQQ)));
const canNext = computed(() => (step.value === 0 ? ownerOk.value : true));

async function loadPairing() {
  try {
    pairing.value = await get('/pairing');
    if (pairing.value.paired) form.ownerQQ = String(pairing.value.ownerQQ ?? form.ownerQQ);
  } catch (e) { /* 面板刚起来时可能还没就绪 */ }
}

async function generatePairing() {
  try {
    pairing.value = await post('/pairing', {});
    toast('配对码已生成，去私聊她');
  } catch (e) { toastError(e); }
}

async function cancelPairing() {
  try {
    pairing.value = await api('/pairing', { method: 'DELETE' });
    toast('已取消配对码', 'info');
  } catch (e) { toastError(e); }
}

async function load() {
  try {
    const c = await get('/config');
    form.ownerQQ = c.ownerQQ ? String(c.ownerQQ) : '';
    form.privateIds = [...(c.allow.private ?? [])];
    if (!form.privateIds.length && c.ownerQQ) form.privateIds = [String(c.ownerQQ)];
    form.groups = [...(c.allow.groups ?? [])];
    form.httpUrl = c.snowluma.httpUrl;
    form.dshBaseUrl = c.dsh.baseUrl;
    hasToken.value = c.snowluma.hasToken;
    if (!c.warnings.length) done.value = true;
  } catch (e) { toastError(e); }
  await loadPairing();
}

async function save() {
  saving.value = true;
  try {
    await post('/setup', {
      ownerQQ: String(form.ownerQQ),
      private: form.privateIds,
      groups: form.groups,
      token: form.token,
      dshBaseUrl: form.dshBaseUrl,
    });
    await refreshOverview({ silent: true });
    hasToken.value = hasToken.value || Boolean(form.token);
    form.token = '';
  } catch (e) {
    toastError(e);
    throw e;
  } finally { saving.value = false; }
}

async function next() {
  if (!canNext.value) { toast('先把主人 QQ 填对（5~12 位数字）', 'err'); return; }
  try {
    await save();
    if (step.value < STEPS.length - 1) step.value += 1;
    if (step.value === STEPS.length - 1) {
      done.value = true;
      toast('配好了，可以启动了');
    }
  } catch { /* toastError 已经提示 */ }
}

async function finish() {
  router.push('/');
}

onMounted(async () => {
  await load();
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    await loadPairing();
    if (pairing.value.paired) { clearInterval(pollTimer); pollTimer = null; await refreshOverview({ silent: true }); }
  }, 2500);
  tickTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
});
</script>

<template>
  <Card
    v-if="!pairing.paired"
    title="一键配对"
    dim="新用户从这里开始"
  >
    <div v-if="gateway?.ok" class="row" style="margin-bottom: 12px">
      <span class="badge ok">网关已登录</span>
      <span class="dim">{{ gateway.nickname || 'QQ' }} · {{ gateway.uin }}</span>
      <span class="muted small">来自 {{ gateway.httpUrl }}</span>
    </div>

    <template v-if="pairing.active">
      <div class="row" style="gap: 18px; align-items: flex-end">
        <div class="big" style="font-size: 40px; letter-spacing: 10px; font-family: ui-monospace, Consolas, monospace">
          {{ pairing.code }}
        </div>
        <div class="muted small">剩余 {{ remainText }} · 还能错 {{ pairing.attemptsLeft }} 次</div>
      </div>
      <div class="hint" style="margin-top: 12px">
        用<b>你自己的 QQ</b>私聊她，把这 6 位数字发过去 —— 她会把你认成主人，并自动加入白名单。
        发完这里会自动变成「已认主」，不用刷新。
      </div>
      <div class="row" style="margin-top: 14px">
        <button class="btn sm ghost" @click="generatePairing">换一个码</button>
        <button class="btn sm danger" @click="cancelPairing">取消配对</button>
        <button class="btn sm" @click="loadPairing">手动刷新</button>
      </div>
    </template>

    <template v-else>
      <div class="hint">现在还没有有效的配对码。生成一个，然后私聊发给她就行。</div>
      <div class="row" style="margin-top: 14px">
        <button class="btn primary" @click="generatePairing">生成配对码</button>
        <RouterLink to="/config" class="btn ghost">改用 QQ 号手动填</RouterLink>
      </div>
    </template>
  </Card>

  <div v-else class="banner info">
    <span>✅</span>
    <div>
      <b>已认主：{{ pairing.ownerQQ }}</b>
      <div class="small" style="margin-top: 3px">
        她已经只回这个号（和下面白名单里的群）了。要换人，去「配置」清空 ownerQQ 再配对。
      </div>
    </div>
  </div>

  <Card title="大脑（DSH）" dim="她回不回消息，取决于这个">
    <div class="row" style="margin-bottom: 10px">
      <span class="pill">
        <span class="dot" :class="dshState?.ok ? 'ok' : 'bad'" />
        <b>DSH</b>
        <span class="mono muted">{{ dshState?.baseUrl || '未配置' }}</span>
      </span>
      <span class="badge" :class="dshState?.ok ? 'ok' : 'err'">{{ dshText }}</span>
      <span v-if="dshState?.registration?.profile" class="badge">
        profile {{ dshState.registration.profile }}
      </span>
      <span v-if="dshState?.registration" class="badge" :class="dshState.registration.registered ? 'ok' : 'warn'">
        {{ dshState.registration.registered ? '工具已注册' : '工具未注册' }}
      </span>
    </div>

    <div class="hint">
      DSH 的端口每次启动都可能变。点「自动检测」会找本机正在监听的 DSH，找到后可一键写入配置。
    </div>

    <div class="row" style="margin-top: 12px">
      <button class="btn" :disabled="dshChecking" @click="checkDsh">
        <Icon name="refresh" :size="14" /> {{ dshChecking ? '检测中…' : '自动检测' }}
      </button>
      <button v-if="dsh?.ok && dsh.baseUrl" class="btn primary" @click="applyDsh">用这个地址</button>
      <RouterLink to="/config" class="btn ghost">手动填</RouterLink>
    </div>

    <div v-if="dsh && !dsh.ok" class="banner err" style="margin: 12px 0 0">
      <span>🧠</span>
      <div>
        <b>没找到在运行的 DSH</b>
        <div class="small">{{ dsh.error }}</div>
        <div class="small" style="margin-top: 4px">先安装并打开 DeepSeek Harness（DSH），登录模型后再点一次「自动检测」。</div>
      </div>
    </div>

    <div v-if="dsh?.ok && !dsh.registration?.registered" class="banner warn" style="margin: 12px 0 0">
      <span>⚠️</span>
      <div>
        <b>DSH 里还没注册小鱼的工具</b>
        <div class="small">跑一次 <code>npm run setup-dsh</code>，然后重启 DSH，MCP 工具和 qq-chat preset 才会生效。</div>
      </div>
    </div>
  </Card>

  <div class="row" style="margin: 4px 0 10px">
    <span class="muted small">或者手动填（已经有主人 / 不想配对时）：</span>
  </div>

  <div class="steps">
    <div
      v-for="(s, i) in STEPS" :key="s"
      class="step" :class="{ active: step === i, done: step > i || done }"
    >
      <span class="n">{{ step > i || done ? '✓' : i + 1 }}</span>{{ s }}
    </div>
  </div>

  <div v-if="done" class="banner info">
    <span>✅</span>
    <div>
      <b>已经配好了</b>
      <div class="small" style="margin-top: 3px">
        下一步：点「启动全部」，然后看「日志」里大脑有没有连上 QQ 网关。
      </div>
    </div>
  </div>

  <Card v-if="step === 0" title="① 她听谁的话" dim="只回白名单里的人">
    <div class="form-grid">
      <Field class="span-2" label="你的 QQ 号（ownerQQ）" hint="审批、管理命令、封闭模式只认这个号">
        <input v-model="form.ownerQQ" class="input mono" :class="{ invalid: form.ownerQQ && !ownerOk }" placeholder="例如 123456789" inputmode="numeric" />
      </Field>
      <Field label="允许私聊她的 QQ" hint="不填就私聊不了；回车添加">
        <TagInput v-model="form.privateIds" placeholder="QQ 号后回车" />
      </Field>
      <Field label="允许她进的群" hint="不填就只私聊">
        <TagInput v-model="form.groups" placeholder="群号后回车" />
      </Field>
    </div>
    <div class="hint" style="margin-top: 4px">
      白名单为空、又没开 allowAllWhenEmpty 时，她会一条都不回——这是最常见的「她不理我」原因。
    </div>
  </Card>

  <Card v-else-if="step === 1" title="② 接上 QQ 网关" dim="SnowLuma 的 OneBot">
    <div class="form-grid">
      <Field label="OneBot HTTP 地址">
        <input v-model="form.httpUrl" class="input mono" placeholder="http://127.0.0.1:3000" />
      </Field>
      <Field label="accessToken" :hint="hasToken ? '已经有 token；留空表示不改' : 'SnowLuma 里配的那个'">
        <input v-model="form.token" class="input mono" type="password" :placeholder="hasToken ? '••••••（留空 = 不改）' : '粘贴 token'" autocomplete="new-password" />
      </Field>
    </div>
    <div class="hint">不知道填什么就先跳过，之后在「配置」里补。</div>
  </Card>

  <Card v-else-if="step === 2" title="③ 本机装了哪些引擎">
    <template #actions>
      <button class="btn sm ghost" @click="refreshOverview()"><Icon name="refresh" :size="14" /> 重新探测</button>
    </template>
    <div class="row">
      <span class="pill"><span class="dot" :class="caps.snowluma ? 'ok' : 'bad'" /><b>QQ 网关</b></span>
      <span class="pill"><span class="dot" :class="caps.voice ? 'ok' : 'bad'" /><b>声音</b></span>
      <span class="pill"><span class="dot" :class="caps.draw ? 'ok' : 'bad'" /><b>画图</b></span>
      <span class="pill"><span class="dot" :class="caps.sing ? 'ok' : 'bad'" /><b>唱歌</b></span>
    </div>
    <div class="stack" style="margin-top: 14px; gap: 8px">
      <div class="row spread">
        <span class="small muted">SnowLuma</span>
        <span class="mono truncate small" style="max-width: 70%">{{ engines.snowluma?.home || '没找到' }}</span>
      </div>
      <div class="row spread">
        <span class="small muted">GPT-SoVITS</span>
        <span class="mono truncate small" style="max-width: 70%">{{ engines.gptSovits?.home || '没找到（可选）' }}</span>
      </div>
      <div class="row spread">
        <span class="small muted">ComfyUI</span>
        <span class="mono truncate small" style="max-width: 70%">{{ engines.comfyui?.home || '没找到（可选）' }}</span>
      </div>
    </div>
    <div class="hint" style="margin-top: 12px">
      没装不是错误：没装声音就只发文字，没装画图就画不了。路径不对可以在「配置」里手改。
    </div>
  </Card>

  <Card v-else title="④ 好了">
    <div class="stack">
      <div>她的配置已经写好，接下来：</div>
      <div class="row">
        <button class="btn primary" @click="finish">进面板</button>
        <RouterLink to="/logs" class="btn ghost">先看日志</RouterLink>
      </div>
      <div class="hint">启动之后，若她不回消息：先看「日志」，再检查 SnowLuma 是否在线、token 对不对。</div>
    </div>
  </Card>

  <div class="row spread" style="margin-top: 16px">
    <button class="btn ghost" :disabled="step === 0" @click="step -= 1">上一步</button>
    <div class="row">
      <RouterLink v-if="!done" to="/" class="btn ghost">跳过</RouterLink>
      <button v-if="step < STEPS.length - 1" class="btn primary" :disabled="!canNext || saving" @click="next">
        {{ saving ? '保存中…' : '保存并下一步' }}
      </button>
      <button v-else class="btn primary" @click="finish">进面板</button>
    </div>
  </div>
</template>
