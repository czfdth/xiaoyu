// 语义检索：把她的旧聊天/记忆/日记做成向量索引，用本地 bge-m3（Ollama）算相似度。
//
// 为什么值得单独做：她现在"想起以前说过什么"靠关键词匹配 —— 说"薯片"能翻到，说"那个膨化零食"
// 就翻不到。bge-m3 只有 1.2 GB、毫秒级、不需要 GPU 满载，是这台机器上本地模型最划算的用法；
// 而且它**不参与聊天生成**，接坏了最多是搜不到，不会影响她说话。
//
// 约定：
//   · 索引落盘为 state/semantic-index.json（向量用 base64 存 Float32，别用 JSON 数组，体积差 4 倍）
//   · 每条都带 kind / day / key，方便按会话或时间过滤
//   · Ollama 不在线时**静默降级**成空结果，调用方继续用关键词

import fs from 'node:fs';
import path from 'node:path';

export const SEMANTIC_INDEX_VERSION = 1;
export const SEMANTIC_MODEL_DEFAULT = 'bge-m3';
export const SEMANTIC_BASE_DEFAULT = 'http://127.0.0.1:11434';
export const SEMANTIC_DIM_EXPECTED = 1024;
export const SEMANTIC_BATCH = 32;

/** 余弦相似度（两边都是 Float32Array 或普通数组）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Float32Array -> base64（索引文件里存这个，比 JSON 数组小一半以上）。 */
export function encodeVector(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

/** base64 -> Float32Array。长度不是 4 的倍数就当作损坏，返回空向量。 */
export function decodeVector(b64) {
  const buf = Buffer.from(String(b64 ?? ''), 'base64');
  // Buffer.from(x, 'base64') 对非法输入是"能解多少解多少"，所以必须自己校验长度：
  // 字节数不是 4 的倍数就没法转成 Float32Array（会直接抛）。
  if (!buf.length || buf.byteLength % 4 !== 0) return new Float32Array(0);
  // 复制一份再交给 Float32Array：Buffer 的底层内存可能不是 4 字节对齐
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

/** 归一化一条检索结果，给工具/控制台用。 */
export function shapeHit(entry, score) {
  return {
    id: entry.id,
    kind: entry.kind,
    day: entry.day ?? '',
    key: entry.key ?? '',
    who: entry.who ?? '',
    text: String(entry.text ?? '').slice(0, 300),
    score: Math.round(score * 1000) / 1000,
  };
}

/** 读索引；文件不存在或损坏都返回空索引，不抛。 */
export function loadIndex(file) {
  const empty = { version: SEMANTIC_INDEX_VERSION, model: SEMANTIC_MODEL_DEFAULT, dim: 0, generatedAt: 0, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || !Array.isArray(raw.entries)) return empty;
    return {
      version: Number(raw.version) || SEMANTIC_INDEX_VERSION,
      model: String(raw.model || SEMANTIC_MODEL_DEFAULT),
      dim: Number(raw.dim) || 0,
      generatedAt: Number(raw.generatedAt) || 0,
      entries: raw.entries.map((e) => ({ ...e, vec: decodeVector(e.vec) })),
    };
  } catch {
    return empty;
  }
}

/** 写索引（原子写：先写临时文件再 rename，避免半截文件被读到）。 */
export function saveIndex(file, index) {
  const payload = {
    version: SEMANTIC_INDEX_VERSION,
    model: index.model,
    dim: index.dim,
    generatedAt: index.generatedAt,
    entries: index.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      day: e.day ?? '',
      key: e.key ?? '',
      who: e.who ?? '',
      // 内容指纹要落盘：不然下次加载读不回来，增量建索引永远「复用 0 条」、每次都全量重算
      hash: e.hash ?? '',
      text: e.text,
      vec: encodeVector(e.vec),
    })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, file);
  return { entries: payload.entries.length, bytes: fs.statSync(file).size };
}

/** 调 Ollama 批量算向量；失败返回 []，调用方据此降级。 */
export async function embedTexts({
  texts,
  model = SEMANTIC_MODEL_DEFAULT,
  baseUrl = SEMANTIC_BASE_DEFAULT,
  fetchImpl = fetch,
  batch = 8,
  timeoutMs = 300000,
  log = () => {},
} = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length; i += batch) {
    const slice = list.slice(i, i + batch);
    let done = false;
    // 这台机器上 Ollama 偶发 "Only one usage of each socket address"（内部端口冲突），
    // 重试一次通常就好：分批 + 退避重试，别让整次建索引白跑。
    for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // num_gpu:0 —— bge-m3（F16 bert）走 GPU 时 llama-server 会 "terminated: exit status 1"，
          // 纯 CPU 正常（实测单条 2.6s；embedding 本来就是轻活）。
          body: JSON.stringify({ model, input: slice, options: { num_gpu: 0 } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const vectors = data?.embeddings;
        if (!Array.isArray(vectors) || vectors.length !== slice.length) throw new Error('返回的向量数量不对');
        for (const v of vectors) out.push(Float32Array.from(v));
        done = true;
      } catch (error) {
        if (attempt >= 2) {
          log(`语义索引：算向量失败（${error?.message ?? error}），这一批跳过`);
          return [];
        }
        log(`语义索引：第 ${attempt + 1} 次失败（${error?.message ?? error}），2 秒后重试`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  return out;
}

/**
 * 索引里搜。
 * @param {{entries:Array}} index
 * @param {Float32Array} queryVec
 * @param {{k?:number, key?:string, kinds?:string[], minScore?:number}} [options]
 */
export function searchIndex(index, queryVec, { k = 6, key = '', kinds = [], minScore = 0.25 } = {}) {
  if (!index?.entries?.length || !queryVec?.length) return [];
  const scored = [];
  for (const entry of index.entries) {
    if (key && entry.key !== key) continue;
    if (kinds.length && !kinds.includes(entry.kind)) continue;
    const score = cosine(queryVec, entry.vec);
    if (score >= minScore) scored.push(shapeHit(entry, score));
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(50, Number(k) || 6)));
}

/** 一次性搜：读索引 → 算 query 向量 → 排序。Ollama 不在线时返回 []。 */
export async function semanticSearch({
  query,
  file,
  k = 6,
  key = '',
  kinds = [],
  minScore = 0.25,
  model = SEMANTIC_MODEL_DEFAULT,
  baseUrl = SEMANTIC_BASE_DEFAULT,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const index = loadIndex(file);
  if (!index.entries.length) return [];
  const [vec] = await embedTexts({ texts: [q], model, baseUrl, fetchImpl, log });
  if (!vec) return [];
  return searchIndex(index, vec, { k, key, kinds, minScore });
}
