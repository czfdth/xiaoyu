<script setup>
// 视频皮肤：把 dsh-video-skin 的设计语言搬到小鱼控制台。
//
// 原包是 DSH 的客户端插件，不能直接装到这个 Vue 控制台里，所以这里做等价实现：
//   · 一段无声短片循环做背景（素材取自 dsh-video-skin@0.1.5 的 assets/）
//   · 开机动画：片尾淡出、点一下随时跳过
//   · 右下角圆钮开面板：开关 / 透明度 / 重播开机
// 设置存在 localStorage；尊重 prefers-reduced-motion。
import { computed, onMounted, onUnmounted, ref } from 'vue';

const KEY = 'xiaoyu.skin';
const DEFAULTS = { enabled: true, veil: 0.14, boot: true };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

const cfg = ref(load());
const panel = ref(false);
const booting = ref(false);
const bootReady = ref(false);
const bgEl = ref(null);
const bootEl = ref(null);

const reduced = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

const enabled = computed(() => cfg.value.enabled === true);

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cfg.value)); } catch { /* 隐私模式写不进去也无所谓 */ }
}

function applyBodyClass() {
  document.body.classList.toggle('skin-on', enabled.value);
  document.body.style.setProperty('--skin-veil', String(cfg.value.veil));
}

function toggle() {
  cfg.value.enabled = !cfg.value.enabled;
  save();
  applyBodyClass();
  if (cfg.value.enabled) playBoot();
}

function playBoot() {
  if (!cfg.value.boot || reduced) return;
  booting.value = true;
  bootReady.value = false;
  const el = bootEl.value;
  if (!el) return;
  try {
    el.currentTime = 0;
    el.volume = 0.6;
    void el.play();
  } catch { /* 自动播放被拦就纯色淡出 */ }
}

function skipBoot() {
  if (!booting.value) return;
  booting.value = false;
  try { bootEl.value?.pause(); } catch { /* 忽略 */ }
}

function onBootEnded() { booting.value = false; }
function onBootMeta() { bootReady.value = true; }

function setVeil(value) {
  cfg.value.veil = Number(value);
  save();
  document.body.style.setProperty('--skin-veil', String(cfg.value.veil));
}

onMounted(() => {
  // 演示/截图用：?skin=1 强制打开（不写回 localStorage）
  if (new URLSearchParams(location.search).get('skin') === '1') {
    cfg.value.enabled = true;
    cfg.value.boot = false;
  }
  applyBodyClass();
  if (enabled.value) {
    // 等首帧再放开机动画，避免白闪
    setTimeout(playBoot, 300);
    setTimeout(() => { booting.value = false; }, 12000); // 兜底：卡住也别一直盖着
  }
});

onUnmounted(() => {
  document.body.classList.remove('skin-on');
});
</script>

<template>
  <div v-if="enabled" class="skin-layer" aria-hidden="true">
    <video
      ref="bgEl"
      class="skin-bg"
      :style="{ opacity: 1 }"
      src="/media/skin-bg.mp4"
      autoplay
      muted
      loop
      playsinline
      preload="auto"
    />
    <div class="skin-veil" :style="{ background: `rgba(6, 9, 13, ${cfg.veil})` }" />
  </div>

  <transition name="bootfade">
    <div v-if="booting" class="boot-layer" @click="skipBoot">
      <video
        ref="bootEl"
        class="boot-video"
        src="/media/skin-boot.mp4"
        playsinline
        :class="{ ready: bootReady }"
        @ended="onBootEnded"
        @loadeddata="onBootMeta"
        @error="skipBoot"
      />
      <div class="boot-hint">正在启动… <b>点击画面跳过</b></div>
    </div>
  </transition>

  <button class="skin-fab" :class="{ on: enabled }" title="界面皮肤" @click="panel = !panel">✦</button>
  <transition name="panelfade">
    <div v-if="panel" class="skin-panel">
      <div class="row spread">
        <b>界面皮肤</b>
        <button class="btn sm ghost" @click="panel = false">×</button>
      </div>
      <label class="row spread" style="margin-top: 10px">
        <span class="small">视频背景</span>
        <input type="checkbox" :checked="enabled" @change="toggle" />
      </label>
      <label class="stack" style="gap: 4px; margin-top: 10px">
        <span class="small">遮罩浓度 {{ Math.round(cfg.veil * 100) }}%</span>
        <input type="range" min="0" max="0.8" step="0.02" :value="cfg.veil" @input="setVeil($event.target.value)" />
      </label>
      <label class="row spread" style="margin-top: 8px">
        <span class="small">下次启播开机动画</span>
        <input v-model="cfg.boot" type="checkbox" @change="save" />
      </label>
      <button class="btn sm primary" style="margin-top: 10px; width: 100%" @click="playBoot">重播开机动画</button>
      <div class="hint" style="margin-top: 8px">素材来自 dsh-video-skin@0.1.5（MIT）。偏好设置只存在这台机器上。</div>
    </div>
  </transition>
</template>

<style>
.skin-layer { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
.skin-bg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; filter: saturate(1.05) contrast(1.02);
}
.skin-veil { position: absolute; inset: 0; }

/* 开皮肤后，面板改成半透明毛玻璃，让背景透出来 */
body.skin-on .card,
body.skin-on .panel {
  background: rgba(21, 21, 23, .55) !important;
  backdrop-filter: blur(14px) saturate(1.1);
  -webkit-backdrop-filter: blur(14px) saturate(1.1);
  border-color: rgba(120, 160, 200, .18) !important;
}
body.skin-on .nav-item.active { background: rgba(79, 209, 197, .16) !important; }
body.skin-on .main { background: transparent !important; }
body.skin-on .sidebar { background: rgba(27, 27, 28, .48) !important; backdrop-filter: blur(12px); }
body.skin-on .card { border-radius: 16px; }

.boot-layer {
  position: fixed; inset: 0; z-index: 90; background: #05070a;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.boot-video { width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .6s ease; }
.boot-video.ready { opacity: 1; }
.boot-hint {
  position: absolute; bottom: 26px; left: 0; right: 0; text-align: center;
  font-size: 12px; color: rgba(220, 235, 255, .6); letter-spacing: .08em;
}
.bootfade-leave-active { transition: opacity .8s ease; }
.bootfade-leave-to { opacity: 0; }

.skin-fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 70;
  width: 38px; height: 38px; border-radius: 50%;
  border: 1px solid rgba(120, 160, 200, .3);
  background: rgba(21, 21, 23, .78); color: #8fb7d8;
  font-size: 15px; cursor: pointer; backdrop-filter: blur(8px);
}
.skin-fab.on { color: #4fd1c5; border-color: rgba(79, 209, 197, .5); }
.skin-panel {
  position: fixed; right: 18px; bottom: 66px; z-index: 71; width: 260px;
  padding: 14px; border-radius: 14px;
  border: 1px solid rgba(120, 160, 200, .22);
  background: rgba(21, 21, 23, .96); backdrop-filter: blur(16px);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .45);
}
.skin-panel input[type="range"] { width: 100%; }
.panelfade-enter-active, .panelfade-leave-active { transition: opacity .18s ease, transform .18s ease; }
.panelfade-enter-from, .panelfade-leave-to { opacity: 0; transform: translateY(6px); }
</style>
