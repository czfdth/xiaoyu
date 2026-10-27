import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cosine,
  encodeVector,
  decodeVector,
  loadIndex,
  saveIndex,
  searchIndex,
  embedTexts,
  semanticSearch,
  shapeHit,
} from '../src/semantic-index.js';

test('余弦相似度：同向=1、正交=0、长度不等=0', () => {
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 1000) / 1000, 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
  assert.equal(cosine(null, [1]), 0);
  // 长度不同但方向相同的向量：3-4-5 直角边
  assert(Math.abs(cosine([1, 1], [2, 2]) - 1) < 1e-9);
});

test('向量编码往返不失真（base64 + Float32）', () => {
  const vec = Float32Array.from([0.1, -0.25, 3.5, 0, 1e-3]);
  const back = decodeVector(encodeVector(vec));
  assert.equal(back.length, vec.length);
  for (let i = 0; i < vec.length; i += 1) assert.ok(Math.abs(back[i] - vec[i]) < 1e-6);
  assert.equal(decodeVector('').length, 0);
  assert.equal(decodeVector('不是base64').length, 0);
});

test('索引读写：不存在/损坏都当空索引，写出来的能读回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-sem-'));
  const file = path.join(dir, 'semantic-index.json');
  assert.equal(loadIndex(file).entries.length, 0, '文件不存在');

  fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
  assert.equal(loadIndex(file).entries.length, 0, '文件损坏');

  const entries = [
    { id: 'j:1', kind: 'journal', day: '2026-10-26', key: 'private:1', who: '她', text: '画册第九张卡住了', hash: 'abc123', vec: Float32Array.from([1, 0, 0]) },
    { id: 'm:2', kind: 'memory', day: '', key: '', who: '记忆', text: '她不太会画画', vec: Float32Array.from([0, 1, 0]) },
  ];
  const saved = saveIndex(file, { model: 'bge-m3', dim: 3, generatedAt: Date.now(), entries });
  assert.equal(saved.entries, 2);
  const back = loadIndex(file);
  assert.equal(back.entries.length, 2);
  assert.equal(back.dim, 3);
  assert.equal(back.entries[0].text, '画册第九张卡住了');
  assert.equal(back.entries[0].vec.length, 3);
  // 指纹必须落盘：读不回来的话 build-semantic-index 永远「复用 0 条」，每次全量重算
  assert.equal(back.entries[0].hash, 'abc123');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('检索：按相似度排序、支持按会话与类型过滤、低于阈值不返回', () => {
  const index = {
    entries: [
      { id: 'a', kind: 'journal', key: 'g:1', who: '她', text: '画不出来', vec: Float32Array.from([1, 0]) },
      { id: 'b', kind: 'journal', key: 'g:2', who: '她', text: '今晚不睡', vec: Float32Array.from([0, 1]) },
      { id: 'c', kind: 'diary', key: '', who: '日记', text: '画册的事', vec: Float32Array.from([0.9, 0.1]) },
    ],
  };
  const top = searchIndex(index, Float32Array.from([1, 0]), { k: 2 });
  assert.equal(top.length, 2);
  assert.equal(top[0].id, 'a');
  assert.ok(top[0].score > top[1].score);

  assert.deepEqual(searchIndex(index, Float32Array.from([0, 1]), { key: 'g:2' }).map((h) => h.id), ['b']);
  assert.deepEqual(searchIndex(index, Float32Array.from([1, 0]), { kinds: ['diary'] }).map((h) => h.id), ['c']);
  assert.deepEqual(searchIndex(index, Float32Array.from([0, 1]), { minScore: 0.99 }).map((h) => h.id), ['b']);
  assert.deepEqual(searchIndex({ entries: [] }, Float32Array.from([1, 0])), []);
  assert.deepEqual(searchIndex(index, new Float32Array(0)), []);
});

test('shapeHit：分数保留三位、正文截断到 300 字', () => {
  const h = shapeHit({ id: 'x', kind: 'journal', day: '2026-10-26', key: 'g:1', who: '她', text: 'a'.repeat(400) }, 0.8532);
  assert.equal(h.score, 0.853);
  assert.equal(h.text.length, 300);
  assert.equal(h.day, '2026-10-26');
});

test('算向量：批量切分、失败时返回空（调用方降级，不抛）', async () => {
  const calls = [];
  const fetchOk = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.input.length);
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
  };
  const vecs = await embedTexts({ texts: Array.from({ length: 70 }, (_, i) => `第${i}条`), fetchImpl: fetchOk, batch: 32 });
  assert.equal(vecs.length, 70);
  assert.deepEqual(calls, [32, 32, 6]);

  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.deepEqual(await embedTexts({ texts: ['x'], fetchImpl: failing }), []);

  const throwing = async () => { throw new Error('连不上'); };
  assert.deepEqual(await embedTexts({ texts: ['x'], fetchImpl: throwing }), []);
  assert.deepEqual(await embedTexts({ texts: [] }), []);
});

test('语义搜索：索引为空或算不出向量时安静返回空数组', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-sem2-'));
  const file = path.join(dir, 'semantic-index.json');
  const fetchOk = async (url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
  };
  assert.deepEqual(await semanticSearch({ query: '画不出来', file, fetchImpl: fetchOk }), [], '没有索引');

  saveIndex(file, {
    model: 'bge-m3', dim: 2, generatedAt: Date.now(),
    entries: [{ id: 'a', kind: 'journal', key: 'g:1', who: '她', text: '画不出来', vec: Float32Array.from([1, 0]) }],
  });
  const hits = await semanticSearch({ query: '卡住了', file, fetchImpl: fetchOk, minScore: 0.5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'a');

  const down = async () => { throw new Error('Ollama 没开'); };
  assert.deepEqual(await semanticSearch({ query: '卡住了', file, fetchImpl: down }), [], 'Ollama 不在线');
  fs.rmSync(dir, { recursive: true, force: true });
});
