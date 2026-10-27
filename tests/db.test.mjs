import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, syncJournal, journalQuery, dailyCounts, stats, closeDb } from '../src/db.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-db-'));
  const journal = path.join(dir, 'journal');
  fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, '2026-10-26.jsonl'), [
    JSON.stringify({ key: 'private:1', t: 1000, role: 'her', text: '在' }),
    JSON.stringify({ key: 'private:1', t: 2000, role: 'owner', sender: '他', text: '在吗' }),
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(journal, '2026-10-27.jsonl'), [
    JSON.stringify({ key: 'group:9', t: 3000, role: 'other', sender: '数分椰椰', text: '哈哈' }),
  ].join('\n'), 'utf8');
  return { dir, journal, dbFile: path.join(dir, 'life.db') };
}

test('同步：第一次全量灌入，第二次幂等（不重复插）', () => {
  const { dir, journal, dbFile } = fixture();
  const db = openDb(dbFile);
  const first = syncJournal(db, journal);
  assert.equal(first.inserted, 3);
  assert.equal(stats(db).rows, 3);
  const second = syncJournal(db, journal);
  assert.equal(second.inserted, 0, '第二次不该重复插');
  assert.equal(stats(db).rows, 3);
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同步：文件追加后只补新增的行', () => {
  const { dir, journal, dbFile } = fixture();
  const db = openDb(dbFile);
  syncJournal(db, journal);
  fs.appendFileSync(path.join(journal, '2026-10-27.jsonl'),
    `\n${JSON.stringify({ key: 'group:9', t: 4000, role: 'her', text: '嗯' })}`, 'utf8');
  const again = syncJournal(db, journal);
  assert.equal(again.inserted, 1);
  assert.equal(stats(db).rows, 4);
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('查询：按会话、按时间倒序；按天统计她/对方', () => {
  const { dir, journal, dbFile } = fixture();
  const db = openDb(dbFile);
  syncJournal(db, journal);

  const rows = journalQuery(db, { key: 'private:1', limit: 10 });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].t >= rows[1].t, '要按时间倒序');
  assert.equal(rows[1].text, '在');

  assert.equal(journalQuery(db, { since: 2500 }).length, 1, '只剩 3000 那条');
  assert.equal(journalQuery(db, { key: '不存在' }).length, 0);

  const days = dailyCounts(db, { days: 5 });
  const d26 = days.find((d) => d.day === '2026-10-26');
  assert.deepEqual({ her: d26.her, other: d26.other }, { her: 1, other: 1 });

  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('坏行不会打断同步', () => {
  const { dir, journal, dbFile } = fixture();
  fs.appendFileSync(path.join(journal, '2026-10-27.jsonl'), '\n{坏 json', 'utf8');
  const db = openDb(dbFile);
  const r = syncJournal(db, journal);
  assert.equal(r.inserted, 3, '坏行跳过，好行照插');
  closeDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});
