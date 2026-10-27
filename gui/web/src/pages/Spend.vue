<script setup>
import { computed, onMounted, ref } from 'vue';
import { get, post } from '../api.js';
import { toast, toastError } from '../store.js';
import Card from '../components/Card.vue';

const data = ref(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const form = ref({
  maxStepsPerTurn: 30,
  rotatePromptTokens: 45000,
  rotateMinTurns: 5,
  idleRotateAfterMs: 20 * 60 * 1000,
  idleRotateTokens: 35000,
  repeatToolLimit: 2,
});

const totals = computed(() => data.value?.totals ?? {});
const days = computed(() => data.value?.days ?? []);
const sessions = computed(() => data.value?.sessions ?? []);
const rotateAt = computed(() => Number(data.value?.budget?.rotatePromptTokens ?? 45000));

// 面板上按「分钟」显示，存的时候还是毫秒（配置里就是毫秒）。
const idleMinutes = computed({
  get: () => Math.round((Number(form.value.idleRotateAfterMs) || 0) / 60000),
  set: (v) => { form.value.idleRotateAfterMs = Math.max(0, Number(v) || 0) * 60000; },
});

const PRESETS = [
  {
    id: 'lean', label: '省一点',
    desc: '3 万就换、空闲 10 分钟就换新会话',
    budget: { maxStepsPerTurn: 20, rotatePromptTokens: 30000, rotateMinTurns: 3, idleRotateAfterMs: 600000, idleRotateTokens: 24000 },
  },
  {
    id: 'balanced', label: '均衡',
    desc: '5 万即换、空闲 20 分钟刷新（默认）',
    budget: { maxStepsPerTurn: 30, rotatePromptTokens: 45000, rotateMinTurns: 5, idleRotateAfterMs: 1200000, idleRotateTokens: 35000 },
  },
  {
    id: 'context', label: '保上下文',
    desc: '10 万才换、空闲 40 分钟才刷新',
    budget: { maxStepsPerTurn: 40, rotatePromptTokens: 100000, rotateMinTurns: 10, idleRotateAfterMs: 2400000, idleRotateTokens: 40000 },
  },
];
const activePreset = computed(() => PRESETS.find((p) => Object.entries(p.budget)
  .every(([k, v]) => Number(form.value[k]) === Number(v)))?.id ?? '');

async function applyPreset(p) {
  form.value = { ...form.value, ...p.budget };
  await save(`已切到「${p.label}」；桥接重启后生效`);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await get('/tokens?days=7');
    form.value = { ...(data.value?.budget ?? form.value) };
  } catch (e) {
    error.value = String(e?.message ?? e);
    toastError(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function num(n) {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(2)} 亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)} 万`;
  return String(Math.round(v));
}

function money(n) {
  const v = Number(n) || 0;
  return v >= 100 ? `¥${v.toFixed(0)}` : `¥${v.toFixed(2)}`;
}

function pct(n) {
  return `${((Number(n) || 0) * 100).toFixed(1)}%`;
}

async function save(message = '已保存；桥接重启后按新预算执行') {
  if (saving.value) return;
  saving.value = true;
  try {
    const r = await post('/tokens/budget', {
      maxStepsPerTurn: Number(form.value.maxStepsPerTurn),
      rotatePromptTokens: Number(form.value.rotatePromptTokens),
      rotateMinTurns: Number(form.value.rotateMinTurns),
      idleRotateAfterMs: Number(form.value.idleRotateAfterMs),
      idleRotateTokens: Number(form.value.idleRotateTokens),
      repeatToolLimit: Number(form.value.repeatToolLimit),
    });
    form.value = { ...r.budget };
    toast(message);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="stack" style="gap: 14px">
    <Card title="花在哪" :dim="data?.model ? `模型 ${data.model}` : ''">
      <template #actions>
        <button class="btn sm" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
      </template>

      <div v-if="error" class="hint" style="color: var(--warn)">{{ error }}</div>

      <div class="row" style="gap: 8px; flex-wrap: wrap">
        <span class="pill"><b>{{ num(totals.steps) }}</b> 步</span>
        <span class="pill"><b>{{ num(totals.prompt) }}</b> prompt token</span>
        <span class="pill"><span class="dot" :class="totals.hitRate > 0.9 ? 'ok' : 'warn'" /><b>命中 {{ pct(totals.hitRate) }}</b></span>
        <span class="pill"><b>{{ num(totals.avgPromptPerStep) }}</b> / 步</span>
        <span class="pill">
          <span class="dot" :class="totals.coldShare > 0.5 ? 'warn' : 'ok'" />
          <b>冷启动 {{ num(totals.coldStarts) }} 次</b>
        </span>
        <span class="pill"><b>{{ money(totals.cost) }}</b> 估算花费</span>
      </div>

      <div class="hint" style="margin-top: 10px">
        命中率很高也不代表便宜：未命中的 token 只占 {{ pct(1 - totals.hitRate) }}，但单价是命中的几十倍。
        未命中主要来自两处——<b>冷启动</b>（空闲超过缓存有效期后，回合第一步按未命中价重读整段上下文：
        {{ num(totals.coldStarts) }} 次 / {{ num(totals.coldMiss) }} token，占未命中的 {{ pct(totals.coldShare) }}），
        和<b>长回合</b>（每一步都要重新带上新增内容，几十步就是几十次）。
        两者都随上下文变大而变贵，所以真正有效的不是省字，而是别让一条会话长到几十万 token。
      </div>

      <div v-if="days.length" class="table-wrap" style="margin-top: 12px">
        <table class="table">
          <thead>
            <tr>
              <th>日期</th><th>步数</th><th>prompt</th><th>缓存命中</th><th>输出</th><th>花费</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in days" :key="d.day">
              <td class="mono">{{ d.day }}</td>
              <td>{{ num(d.steps) }}</td>
              <td>{{ num(d.prompt) }}</td>
              <td>
                <span class="badge" :class="d.hitRate > 0.9 ? 'ok' : 'warn'">{{ pct(d.hitRate) }}</span>
              </td>
              <td>{{ num(d.output) }}</td>
              <td>{{ money(d.cost) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>

    <Card title="上下文预算" :dim="'三档预设 + 细调'">
      <div class="stack" style="gap: 12px">
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button
            v-for="p in PRESETS" :key="p.id"
            class="btn sm" :class="activePreset === p.id ? 'primary' : 'ghost'"
            :disabled="saving"
            :title="p.desc"
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
          <span class="muted small" style="align-self: center">
            {{ PRESETS.find((p) => p.id === activePreset)?.desc || '自定义' }}
          </span>
        </div>

        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <label class="stack" style="gap: 4px">
            <span class="muted small">单回合最多几步</span>
            <input v-model.number="form.maxStepsPerTurn" class="input" type="number" min="0" max="500" style="width: 130px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">单步 prompt 到多少就换会话</span>
            <input v-model.number="form.rotatePromptTokens" class="input" type="number" min="0" max="2000000" step="5000" style="width: 170px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">至少跑过几个回合才换</span>
            <input v-model.number="form.rotateMinTurns" class="input" type="number" min="0" max="1000" style="width: 150px" />
          </label>
        </div>

        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <label class="stack" style="gap: 4px">
            <span class="muted small">空闲多少分钟后就起新会话</span>
            <input v-model.number="idleMinutes" class="input" type="number" min="0" max="1440" style="width: 170px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">会话小于这个规模就不刷新</span>
            <input v-model.number="form.idleRotateTokens" class="input" type="number" min="0" max="2000000" step="5000" style="width: 180px" />
          </label>
          <button class="btn primary sm" :disabled="saving" style="align-self: flex-end" @click="save()">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="hint">
          <b>步数上限</b>：一个回合跑到这么多步还没收尾就打断（正常聊天 1~6 步，几十步基本在打转）。
          <b>换会话</b>：单步 prompt 超过阈值后，这一轮结束换一条新 DSH 会话，带上最近 20 条消息接力。
          <b>空闲刷新</b>：空闲到缓存肯定过期时，下一次唤醒本来就要按未命中价重读整段历史 —— 直接起新会话更便宜。
          <b>打转打断</b>：同一工具、同样的参数重复 {{ form.repeatToolLimit }} 次就停（等待/已读/唤醒类工具不参与）。
          填 0 关闭对应那一项；改完重启桥接生效。
        </div>
      </div>
    </Card>

    <Card v-if="sessions.length" title="按会话" :dim="`${sessions.length} 个`">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>会话</th><th>会话数</th><th>回合</th><th>步数</th><th>累计 prompt</th><th>最近一步</th><th>花费</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.key">
              <td class="mono">{{ s.key }}</td>
              <td>{{ s.sessions }}</td>
              <td>{{ s.turns }}</td>
              <td>{{ num(s.steps) }}</td>
              <td>{{ num(s.prompt) }}</td>
              <td>
                <span class="badge" :class="rotateAt > 0 && s.lastPrompt >= rotateAt ? 'warn' : ''">
                  {{ num(s.lastPrompt) }}
                </span>
              </td>
              <td>{{ money(s.cost) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="hint" style="margin-top: 8px">
        「最近一步」标黄说明这条会话已经到轮换线附近——它每走一步都在重发这么多 token。
      </div>
    </Card>
  </div>
</template>
