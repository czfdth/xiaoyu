import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyStore, loadStore, saveStore, upsertEntity, resolveEntity, upsertFact, factsAbout, factsHint, factsFromSentences,
} from '../src/knowledge-graph.js';

test('实体与别名：他 / 爸 / 栗子 指向同一个人', () => {
  const store = emptyStore();
  upsertEntity(store, '他', { aliases: ['爸', '栗子'] });
  assert.equal(resolveEntity(store, '爸'), '他');
  assert.equal(resolveEntity(store, '栗子'), '他');
  assert.equal(resolveEntity(store, '他'), '他');
  assert.equal(resolveEntity(store, '数分椰椰'), '数分椰椰', '没登记的原样返回');
});

test('事实：同一谓词的新值会顶掉旧值，但旧值保留历史', () => {
  const store = emptyStore();
  upsertEntity(store, '他');
  const a = upsertFact(store, { subject: '他', predicate: '在忙', object: '期末复习', at: 1000, source: '他说要复习' });
  assert.equal(a.added, true);
  const b = upsertFact(store, { subject: '他', predicate: '在忙', object: '准备考研', at: 2000, source: '他说要考研' });
  assert.equal(b.added, true);
  assert.equal(b.superseded, 1, '旧值要被标 validTo');
  const live = factsAbout({ store, name: '他' });
  assert.equal(live.length, 1);
  assert.equal(live[0].object, '准备考研');
  const all = store.facts.filter((f) => f.subject === '他');
  assert.equal(all.length, 2, '历史保留，不删');
  assert.ok(all.find((f) => f.object === '期末复习').validTo, '旧值有 validTo');
});

test('事实：重复写入不会堆重复，置信度取高', () => {
  const store = emptyStore();
  upsertFact(store, { subject: '他', predicate: '喜欢', object: '吃鱼', at: 1, confidence: 0.4 });
  const again = upsertFact(store, { subject: '他', predicate: '喜欢', object: '吃鱼', at: 2, confidence: 0.9 });
  assert.equal(again.added, false);
  assert.equal(store.facts.length, 1);
  assert.equal(store.facts[0].confidence, 0.9);
});

test('factsAbout：按时间倒序、可限时间窗、默认不含失效事实', () => {
  const store = emptyStore();
  upsertFact(store, { subject: '他', predicate: '喜欢', object: '鱼', at: 100 });
  upsertFact(store, { subject: '他', predicate: '在忙', object: '考研', at: 200 });
  const rows = factsAbout({ store, name: '他', limit: 2 });
  assert.equal(rows[0].object, '考研', '最新的在前');
  const recent = factsAbout({ store, name: '他', since: 150 });
  assert.equal(recent.length, 1);
  assert.equal(factsAbout({ store, name: '他', includeStale: true }).length, 2);
  assert.deepEqual(factsAbout({ store, name: '不存在的人' }), []);
});

test('factsHint：没事实返回空串；有就带谓词和原话', () => {
  assert.equal(factsHint([]), '');
  assert.equal(factsHint(null), '');
  const hint = factsHint([{ predicate: '在忙', object: '考研', source: '他说要考研' }]);
  assert.match(hint, /关于他/);
  assert.match(hint, /在忙：考研/);
  assert.match(hint, /原话：他说要考研/);
});

test('从长时记忆语句抽事实：只抽明确的，不硬编', () => {
  const items = [
    { text: '他叫栗子。', createdAt: 100 },
    { text: '他喜欢发自拍。', createdAt: 200 },
    { text: '他正在准备期末。', createdAt: 300 },
    { text: '今天天气不错。', createdAt: 400 },
    { text: '我们是父女关系：他是我爸。', createdAt: 500 },
  ];
  const facts = factsFromSentences(items);
  const objects = facts.map((f) => `${f.predicate}=${f.object}`);
  assert.ok(objects.includes('叫=栗子'), objects.join(' | '));
  assert.ok(objects.includes('喜欢=发自拍'), objects.join(' | '));
  assert.ok(objects.every((o) => !o.includes('天气')), '抽不出的不要硬编');
  assert.ok(facts.every((f) => f.subject === '他'));
  assert.ok(facts.every((f) => f.source && f.confidence > 0), '每条都要有来源和置信度');
});

test('存取：坏文件当空库，能正常落盘读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-kg-'));
  const file = path.join(dir, 'facts.json');
  assert.deepEqual(loadStore(file), emptyStore());
  fs.writeFileSync(file, 'not json', 'utf8');
  assert.deepEqual(loadStore(file), emptyStore());

  const store = emptyStore();
  upsertFact(store, { subject: '他', predicate: '叫', object: '栗子' });
  assert.equal(saveStore(file, store), true);
  const back = loadStore(file);
  assert.equal(back.facts.length, 1);
  assert.equal(back.facts[0].object, '栗子');
  fs.rmSync(dir, { recursive: true, force: true });
});
