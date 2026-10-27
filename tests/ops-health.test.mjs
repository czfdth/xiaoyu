import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecret, scanSecrets, keyHealth, diskReport, cleanup, latestBackup, composeDailyReport } from '../src/ops.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-ops2-'));
}

test('maskSecret：只露头尾，短串直接打码', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnop'), 'sk-a…mnop');
  assert.equal(maskSecret('short'), '***');
  assert.equal(maskSecret(''), '***');
});

test('scanSecrets：认出 sk/gh/bearer，报文件行号但不回显完整密钥', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'conf.json');
  fs.writeFileSync(file, ['{', '  "apiKey": "sk-1234567890abcdefghij",', '  "gh": "ghp_abcdefghijklmnopqrstuvwxyz01",', '  "auth": "Bearer abcdefghijklmnopqrstuvwxyz"', '}'].join('\n'), 'utf8');
  const hits = scanSecrets([file]);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.kind), ['deepseek/sk', 'github', 'bearer']);
  assert.equal(hits[0].line, 2);
  assert.ok(!hits[0].masked.includes('1234567890abcdefghij'), '不能把完整密钥打出来');
  assert.deepEqual(scanSecrets([path.join(dir, 'nope.json')]), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keyHealth：配置文件明文要警告，日志泄漏更要警告', () => {
  const dir = tmpDir();
  const conf = path.join(dir, 'companion.json');
  const log = path.join(dir, 'bridge.log');
  fs.writeFileSync(conf, '{"apiKey":"sk-aaaaaaaaaaaaaaaaaaaa"}', 'utf8');
  fs.writeFileSync(log, 'boom sk-bbbbbbbbbbbbbbbbbbbb\n', 'utf8');

  const bad = keyHealth({ configFiles: [conf], logFiles: [log] });
  assert.equal(bad.ok, false);
  assert.equal(bad.plaintextFiles.length, 1);
  assert.equal(bad.logLeaks.length, 1);
  assert.equal(bad.warnings.length, 2);

  const clean = keyHealth({ configFiles: [path.join(dir, 'none.json')], logFiles: [] });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.warnings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diskReport：分处统计大小，读不到也不炸', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'a.json'), 'x'.repeat(2048));
  const report = diskReport({ home });
  assert.ok(report.state.bytes >= 2048);
  assert.equal(report.state.files, 1);
  assert.ok(report.home.bytes >= report.state.bytes);
  fs.rmSync(home, { recursive: true, force: true });
});

test('cleanup：只删超龄的备份 zip 和日志，绝不动 state', () => {
  const home = tmpDir();
  const backups = path.join(home, 'backups');
  const logs = path.join(home, 'logs');
  const state = path.join(home, 'state');
  for (const d of [backups, logs, state]) fs.mkdirSync(d, { recursive: true });

  const old = Date.now() - 40 * 86400000;
  const fresh = Date.now();
  const oldZip = path.join(backups, 'xiaoyu-old.zip');
  const newZip = path.join(backups, 'xiaoyu-new.zip');
  const otherInBackups = path.join(backups, 'keep-me.txt');
  const oldLog = path.join(logs, 'bridge.log');
  const stateFile = path.join(state, 'social-v2.json');
  for (const f of [oldZip, newZip, otherInBackups, oldLog, stateFile]) fs.writeFileSync(f, 'data');
  fs.utimesSync(oldZip, old / 1000, old / 1000);
  fs.utimesSync(oldLog, old / 1000, old / 1000);
  fs.utimesSync(stateFile, old / 1000, old / 1000);

  // 演练模式：只报不删
  const dry = cleanup({ home, keepBackupDays: 30, keepLogDays: 14, dryRun: true });
  assert.equal(dry.removed.length, 2, '老 zip + 老 log');
  assert.ok(fs.existsSync(oldZip), '演练不能删东西');

  const real = cleanup({ home, keepBackupDays: 30, keepLogDays: 14, dryRun: false });
  assert.equal(real.removed.length, 2);
  assert.equal(fs.existsSync(oldZip), false);
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(newZip), true, '新备份要留着');
  assert.equal(fs.existsSync(otherInBackups), true, '不是备份 zip 的不许碰');
  assert.equal(fs.existsSync(stateFile), true, 'state 里的记忆绝不动');
  fs.rmSync(home, { recursive: true, force: true });
});

test('latestBackup：没有返回 null，有就挑最新那个', () => {
  const dir = tmpDir();
  assert.equal(latestBackup(dir), null);
  const a = path.join(dir, 'xiaoyu-a.zip');
  const b = path.join(dir, 'xiaoyu-b.zip');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  fs.utimesSync(a, 1000, 1000);
  fs.utimesSync(b, 2000, 2000);
  assert.equal(latestBackup(dir).name, 'xiaoyu-b.zip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('composeDailyReport：空数据也能给一句人话，有数据按段落拼', () => {
  const empty = composeDailyReport({ day: '2026-10-27' });
  assert.match(empty, /2026-10-27/);
  assert.match(empty, /说话 0 条/);

  const full = composeDailyReport({
    day: '2026-10-27', herMessages: 63, otherMessages: 49,
    topPeers: [{ who: '他', count: 30 }, { who: '群里', count: 3 }],
    mood: '还算平静', diary: 1, works: 2, tokens: 206350935, cost: 16.66,
    firstAt: '00:13', lastAt: '15:29',
  });
  assert.match(full, /说话 63 条/);
  assert.match(full, /他（30）/);
  assert.match(full, /心情：还算平静/);
  assert.match(full, /写了 1 篇日记/);
  assert.match(full, /画了 2 张/);
  assert.match(full, /¥16.66/);
  assert.match(full, /00:13 到 15:29/);
});
