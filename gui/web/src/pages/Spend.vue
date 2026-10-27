<script setup>
import { computed, onMounted, ref } from 'vue';
import { get, post } from '../api.js';
import { toast, toastError } from '../store.js';
import Card from '../components/Card.vue';

const data = ref(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const form = ref({ maxStepsPerTurn: 30, rotatePromptTokens: 80000, rotateMinTurns: 20 });

const totals = computed(() => data.value?.totals ?? {});
const days = computed(() => data.value?.days ?? []);
const sessions = computed(() => data.value?.sessions ?? []);
const rotateAt = computed(() => Number(data.value?.budget?.rotatePromptTokens ?? 80000));

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

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    const r = await post('/tokens/budget', {
      maxStepsPerTurn: Number(form.value.maxStepsPerTurn),
      rotatePromptTokens: Number(form.value.rotatePromptTokens),
      rotateMinTurns: Number(form.value.rotateMinTurns),
    });
    form.value = { ...r.budget };
    toast('已保存；桥接重启后按新预算执行');
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

    <Card title="上下文预算" dim="两道刹车">
      <div class="stack" style="gap: 10px">
        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <label class="stack" style="gap: 4px">
            <span class="muted small">单回合最多几步</span>
            <input v-model.number="form.maxStepsPerTurn" class="input" type="number" min="0" max="500" style="width: 130px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">单步 prompt 到多少就换会话</span>
            <input v-model.number="form.rotatePromptTokens" class="input" type="number" min="0" max="2000000" step="10000" style="width: 170px" />
          </label>
          <label class="stack" style="gap: 4px">
            <span class="muted small">至少跑过几个回合才换</span>
            <input v-model.number="form.rotateMinTurns" class="input" type="number" min="0" max="1000" style="width: 150px" />
          </label>
          <button class="btn primary sm" :disabled="saving" style="align-self: flex-end" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="hint">
          步数上限：一个回合跑到这么多步还没收尾，桥接会直接打断（正常聊天 1~6 步就结束，跑几十步基本是在同一个工具上打转）。
          轮换：单步 prompt 超过阈值后，这一轮结束就换一条新 DSH 会话，并把最近聊到的几条消息带过去接力。
          填 0 表示关闭对应那一项。改完要重启桥接才生效。
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
