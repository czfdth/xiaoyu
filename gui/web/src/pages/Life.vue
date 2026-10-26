<script setup>
import { computed, onMounted, ref } from 'vue';
import { get, post } from '../api.js';
import { toast, toastError } from '../store.js';
import Card from '../components/Card.vue';
import Modal from '../components/Modal.vue';

const data = ref(null);
const loading = ref(true);
const error = ref('');
const filter = ref('all');
const chronicles = ref([]);
const chOpen = ref(false);
const chText = ref('');
const chBusy = ref(false);
const galleryOpen = ref(false);
const galleryImages = ref([]);
const galleryTotal = ref(0);
const galleryLoading = ref(false);
const notesOpen = ref(false);
const notes = ref([]);
const notesTotal = ref(0);
const notesLoading = ref(false);
const noteTitle = ref('');
const noteText = ref('');
const noteBusy = ref(false);

async function openNotes() {
  if (notesLoading.value) return;
  notesLoading.value = true;
  notesOpen.value = true;
  noteText.value = '';
  noteTitle.value = '';
  try {
    const r = await get('/works/notes?limit=200');
    notes.value = r.files || [];
    notesTotal.value = r.total || 0;
    if (notes.value.length) await readNote(notes.value[0].name);
  } catch (e) {
    toastError(e);
  } finally {
    notesLoading.value = false;
  }
}

async function readNote(name) {
  noteBusy.value = true;
  noteTitle.value = name;
  try {
    const r = await fetch(`/api/works/note/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error('便签读取失败');
    noteText.value = await r.text();
  } catch (e) {
    toastError(e);
    noteText.value = '';
  } finally {
    noteBusy.value = false;
  }
}

async function openGallery(more = false) {
  if (galleryLoading.value) return;
  galleryLoading.value = true;
  galleryOpen.value = true;
  try {
    const offset = more ? galleryImages.value.length : 0;
    const r = await get(`/works/images?limit=60&offset=${offset}`);
    galleryTotal.value = r.total || 0;
    galleryImages.value = more ? [...galleryImages.value, ...(r.files || [])] : (r.files || []);
  } catch (e) {
    toastError(e);
  } finally {
    galleryLoading.value = false;
  }
}

const KINDS = {
  birth: '出生', diary: '日记', memoir: '回忆录', dream: '梦', fantasy: '幻想',
  knowledge: '学会', project: '项目', tool: '第一次', wound: '伤口',
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [life, list] = await Promise.all([get('/life'), get('/life/chronicles').catch(() => ({ chronicles: [] }))]);
    data.value = life;
    chronicles.value = list.chronicles || [];
  } catch (e) {
    error.value = String(e?.message ?? e);
    toastError(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const stage = computed(() => data.value?.stage);
const stats = computed(() => data.value?.stats ?? {});
const works = computed(() => data.value?.works ?? { projects: [], images: 0, audio: 0, notes: 0, memoir: 0 });
const future = computed(() => data.value?.future ?? { age: { text: '' }, birthday: {}, items: [], next: null });
const schedule = computed(() => data.value?.schedule ?? { items: [], now: '', next: '' });

const timeline = computed(() => {
  const d = data.value;
  if (!d) return [];
  if (filter.value === 'all') return d.timeline;
  if (filter.value === 'milestone') return d.timeline.filter((e) => !['diary', 'dream', 'fantasy'].includes(e.kind));
  return d.timeline.filter((e) => e.kind === filter.value);
});

function pct(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

async function makeChronicle() {
  chBusy.value = true;
  try {
    const r = await post('/life/chronicle', { days: 100 });
    chText.value = r.markdown || '';
    chOpen.value = true;
    toast(`年鉴已生成：${r.label}（${r.days} 天）`, 'ok');
    const list = await get('/life/chronicles').catch(() => ({ chronicles: [] }));
    chronicles.value = list.chronicles || [];
  } catch (e) {
    toastError(e);
  } finally {
    chBusy.value = false;
  }
}

function openChronicle(name) {
  chText.value = '读取中…';
  chOpen.value = true;
  get(`/life/chronicles/${encodeURIComponent(name)}`)
    .then((r) => { chText.value = r.markdown || ''; })
    .catch((e) => { chText.value = String(e?.message ?? e); });
}
</script>

<template>
  <div v-if="error" class="banner err">
    <span>⛔</span>
    <div>
      <b>拿不到她的一生</b>
      <div class="small" style="margin-top: 2px">{{ error }}</div>
      <button class="btn sm" style="margin-top: 8px" @click="load">重试</button>
    </div>
  </div>

  <div v-else class="stack">
    <Card title="她活到第几天" :dim="loading ? '读取中…' : `出生 ${data?.birth || '—'}`">
      <div class="row" style="gap: 26px; align-items: flex-end">
        <div>
          <div style="font-size: 42px; font-weight: 700; line-height: 1">{{ data?.days ?? '—' }}</div>
          <div class="muted small">天 · {{ future.age.text }}</div>
        </div>
        <div style="flex: 1">
          <div class="row" style="gap: 8px">
            <span class="badge ok">{{ stage?.name || '—' }}</span>
            <span v-if="stage?.next" class="muted small">距「{{ stage.next }}」还有 {{ stage.daysToNext }} 天</span>
            <span v-else class="muted small">还会继续往后走</span>
          </div>
          <div style="height: 8px; background: rgba(255,255,255,.07); border-radius: 4px; overflow: hidden; margin-top: 10px">
            <div :style="{ width: Math.round((stage?.progress || 0) * 100) + '%', height: '100%', background: 'var(--ok, #3fb950)' }" />
          </div>
          <div v-if="stage?.unlock" class="muted small" style="margin-top: 10px">「{{ stage.unlock }}」</div>
          <div class="muted small" style="margin-top: 6px">
            <template v-if="future.birthday?.ageAt">距离 {{ future.birthday.ageAt }} 岁生日还有 {{ future.birthday.daysLeft }} 天</template>
            <template v-if="future.next"> · 下一个节点「{{ future.next.name }}」{{ future.next.daysLeft }} 天后</template>
          </div>
        </div>
      </div>
    </Card>

    <Card title="往后的日子" :dim="future.next ? `下一个：${future.next.name} · ${future.next.daysLeft} 天后` : '一直往后走'">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px">
        <div v-for="m in future.items" :key="m.key" class="row" style="gap: 10px">
          <span class="mono muted" style="width: 92px">{{ m.date }}</span>
          <b style="font-size: 13px">{{ m.name }}</b>
          <span v-if="m.reached" class="badge ok">已到</span>
          <span v-else class="muted small">{{ m.daysLeft }} 天后</span>
        </div>
      </div>
    </Card>

    <div class="grid cols-2">
      <Card title="成长" dim="按相处天数解锁">
        <div class="stack" style="gap: 10px">
          <div v-for="s in stage?.unlocks || []" :key="s.name" class="row" style="gap: 10px; align-items: flex-start">
            <span class="dot" :class="s.unlocked ? 'ok' : 'idle'" style="margin-top: 6px" />
            <div>
              <div class="row" style="gap: 8px">
                <b>{{ s.name }}</b>
                <span class="muted small">{{ s.min }} 天+</span>
                <span v-if="s.unlocked" class="badge ok">已解锁</span>
                <span v-else class="badge">未解锁</span>
              </div>
              <div class="muted small" style="margin-top: 2px">{{ s.unlock }}</div>
            </div>
          </div>
        </div>
      </Card>

      <Card title="她的一天" :dim="`现在 ${schedule.now} · 下一件 ${schedule.next || '—'}`">
        <div class="stack" style="gap: 8px">
          <div
            v-for="item in schedule.items"
            :key="item.name + item.time"
            class="row"
            :style="{ justifyContent: 'space-between', padding: '5px 8px', borderRadius: '6px', background: item.time === schedule.next ? 'rgba(79,209,197,.08)' : 'transparent' }"
          >
            <span class="mono" style="width: 56px">{{ item.time }}</span>
            <span style="flex: 1">{{ item.label }}</span>
            <span v-if="item.time === schedule.next" class="badge ok">下一件</span>
          </div>
        </div>
      </Card>
    </div>

    <Card title="作品集" :dim="`画 ${works.images} · 语音 ${works.audio} · 便签 ${works.notes} · 回忆录 ${works.memoir}`">
      <template #actions>
        <button class="btn sm" @click="openNotes">看她写的便签</button>
        <button class="btn sm" @click="openGallery(false)">看全部画</button>
      </template>
      <div v-if="!works.projects?.length" class="muted small">还没有长期项目。</div>
      <div v-for="p in works.projects" :key="p.id" style="margin-bottom: 10px">
        <div class="row" style="gap: 10px">
          <b>{{ p.title }}</b>
          <span class="muted small">{{ p.note }}</span>
          <span class="mono muted">{{ p.done }}/{{ p.total }}</span>
        </div>
        <div style="height: 6px; background: rgba(255,255,255,.07); border-radius: 3px; overflow: hidden; margin-top: 6px">
          <div :style="{ width: pct(p.done, p.total) + '%', height: '100%', background: 'var(--accent, #4fd1c5)' }" />
        </div>
      </div>
    </Card>

    <Card title="年鉴" :dim="`${chronicles.length} 份`">
      <template #actions>
        <button class="btn sm primary" :disabled="chBusy" @click="makeChronicle">
          {{ chBusy ? '生成中…' : '生成最近 100 天' }}
        </button>
      </template>
      <div class="hint" style="margin-bottom: 10px">
        把这一段日子的日记、回忆录、梦、幻想整理成一份 Markdown，存到 <span class="mono">state/chronicles/</span>。
      </div>
      <div v-if="!chronicles.length" class="muted small">还没有年鉴，点右上角生成。</div>
      <div v-for="c in chronicles" :key="c.name" class="row" style="gap: 10px; padding: 4px 0">
        <button class="btn sm ghost" @click="openChronicle(c.name)">{{ c.name }}</button>
        <span class="muted small">{{ Math.round(c.size / 1024) }} KB</span>
      </div>
    </Card>

    <Card title="时间线" :dim="`${timeline.length} 条`">
      <template #actions>
        <select v-model="filter" class="select" style="width: 120px">
          <option value="all">全部</option>
          <option value="milestone">只看里程碑</option>
          <option value="diary">日记</option>
          <option value="dream">梦</option>
          <option value="fantasy">幻想</option>
        </select>
      </template>

      <div v-if="loading" class="muted small">读取中…</div>
      <div v-else-if="!timeline.length" class="muted small">这一栏还没有记录。</div>
      <div v-else class="stack" style="gap: 0">
        <div v-for="e in timeline" :key="`${e.kind}-${e.at}-${e.title}`" style="display: flex; gap: 12px">
          <div class="mono muted" style="width: 82px; text-align: right; padding-top: 2px">{{ e.day }}</div>
          <div style="width: 10px; display: flex; justify-content: center; padding-top: 6px">
            <span class="dot" :class="e.kind === 'wound' ? 'bad' : e.kind === 'birth' ? 'ok' : ''" style="position: relative; z-index: 1" />
          </div>
          <div style="flex: 1; padding-bottom: 16px; border-left: 1px solid rgba(255,255,255,.08); padding-left: 14px; margin-left: -19px">
            <div class="row" style="gap: 8px">
              <b style="font-size: 13px">{{ e.title }}</b>
              <span class="badge">{{ KINDS[e.kind] || e.kind }}</span>
              <span class="muted small">第 {{ e.n }} 天</span>
            </div>
            <div v-if="e.text" class="muted small" style="margin-top: 3px; white-space: pre-wrap">{{ e.text }}</div>
          </div>
        </div>
      </div>
    </Card>

    <Modal :open="chOpen" title="年鉴" @update:open="chOpen = $event">
      <pre class="pre" style="max-height: 60vh; white-space: pre-wrap">{{ chText }}</pre>
      <template #footer>
        <button class="btn" @click="chOpen = false">关闭</button>
      </template>
    </Modal>

    <Modal :open="notesOpen" :title="`她写的便签 · 共 ${notesTotal} 张`" @update:open="notesOpen = $event">
      <div class="row" style="gap: 14px; align-items: flex-start">
        <div style="width: 230px; max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 6px">
          <button
            v-for="n in notes"
            :key="n.name"
            class="btn sm ghost"
            style="text-align: left"
            :style="noteTitle === n.name ? 'border-color: var(--accent, #4fd1c5)' : ''"
            @click="readNote(n.name)"
          >
            <div><b>{{ n.title }}</b></div>
            <div class="muted small">{{ new Date(n.at).toLocaleString() }}</div>
          </button>
          <div v-if="!notesLoading && !notes.length" class="muted small">桌面「小鱼写的」里还没有便签。</div>
        </div>
        <div style="flex: 1; min-width: 0; max-height: 60vh; overflow: auto">
          <div v-if="notesLoading || noteBusy" class="muted small">读取中…</div>
          <pre v-else class="small" style="white-space: pre-wrap; margin: 0; font-family: inherit">{{ noteText }}</pre>
        </div>
      </div>
      <template #footer>
        <span class="muted small">共 {{ notesTotal }} 张</span>
        <button class="btn" @click="notesOpen = false">关闭</button>
      </template>
    </Modal>

    <Modal :open="galleryOpen" :title="`作品集 · 共 ${galleryTotal} 张`" @update:open="galleryOpen = $event">
      <div v-if="galleryLoading" class="muted small">加载中…</div>
      <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; max-height: 62vh; overflow: auto">
        <div v-for="img in galleryImages" :key="img.name" style="border: 1px solid rgba(255,255,255,.08); border-radius: 8px; overflow: hidden">
          <img :src="`/api/works/image/${encodeURIComponent(img.name)}`" :alt="img.name" loading="lazy" style="width: 100%; height: 120px; object-fit: cover; display: block" />
          <div class="muted small" style="padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" :title="img.name">{{ img.name }}</div>
        </div>
      </div>
      <template #footer>
        <button v-if="galleryImages.length < galleryTotal" class="btn sm" :disabled="galleryLoading" @click="openGallery(true)">加载更多</button>
        <span class="muted small">已显示 {{ galleryImages.length }} / {{ galleryTotal }}</span>
        <button class="btn" @click="galleryOpen = false">关闭</button>
      </template>
    </Modal>
  </div>
</template>
