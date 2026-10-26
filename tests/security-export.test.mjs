import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSecurity } from '../gui/server/security.mjs';

const ITEMS = [
  { at: Date.parse('2026-10-27T00:00:00Z'), key: 'private:1', reason: 'agent-leak', hasKnownToken: false, text: 'hello, "world"' },
  { at: Date.parse('2026-10-27T00:01:00Z'), key: 'group:2', reason: 'sensitive', hasKnownToken: true, text: '=cmd|calc' },
];

test('安全导出：CSV 有 BOM、表头和转义', () => {
  const out = exportSecurity({ items: ITEMS, format: 'csv' });
  assert.equal(out.count, 2);
  assert.ok(out.body.startsWith('\uFEFFtime,key,reason,has_known_token,text'));
  assert.ok(out.body.includes('"hello, ""world"""'));
});

test('安全导出：CSV 防公式注入', () => {
  const out = exportSecurity({ items: ITEMS, format: 'csv' });
  assert.ok(out.body.includes("'=cmd|calc"));
});

test('安全导出：JSONL 一行一条', () => {
  const out = exportSecurity({ items: ITEMS, format: 'jsonl' });
  const rows = out.body.trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].reason, 'sensitive');
  assert.equal(rows[1].hasKnownToken, true);
});

test('安全导出：按原因和原文筛选', () => {
  const out = exportSecurity({ items: ITEMS, format: 'jsonl', reason: 'sensitive', q: 'CMD' });
  assert.equal(out.count, 1);
  assert.equal(JSON.parse(out.body.trim()).key, 'group:2');
});

test('安全导出：空记录也有表头', () => {
  const out = exportSecurity({ items: [], format: 'csv' });
  assert.equal(out.count, 0);
  assert.ok(out.body.includes('time,key,reason,has_known_token,text'));
});
