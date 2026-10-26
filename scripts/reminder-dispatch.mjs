#!/usr/bin/env node
// 提醒派发器：把 state/reminders.json 里到点的提醒用她的号发出去。
// 由 Windows 计划任务每 5 分钟调一次；不依赖 DSH 会话，重启也不丢。
import { APP_ROOT as ROOT } from '../src/paths.js';
import fs from 'node:fs';
import path from 'node:path';

const bridgeCfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(bridgeCfg.ownerQQ) || 0;

const REMINDER_FILE = path.join(ROOT, 'state', 'reminders.json');
const LOG = path.join(ROOT, 'state', 'reminder-dispatch.log');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch {}
  process.stdout.write(line);
}

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    if (Array.isArray(j?.items)) return j;
  } catch {}
  return { items: [] };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(REMINDER_FILE), { recursive: true });
  fs.writeFileSync(REMINDER_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function cfg() {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

const c = cfg();
const base = String(c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = c.snowluma?.accessToken ?? '';
const allowPrivate = (c.allow?.private ?? []).map(String);

if (!allowPrivate.includes(String(OWNER))) {
  log('owner not in allow.private - refusing to send');
  process.exit(1);
}

const state = readState();
const now = Date.now();
const due = (state.items ?? []).filter((x) => !x.sentAt && !x.cancelledAt && x.dueAt <= now);

if (!due.length) {
  log(`no due reminders (pending ${(state.items ?? []).filter((x) => !x.sentAt && !x.cancelledAt).length})`);
  process.exit(0);
}

for (const item of due) {
  try {
    const res = await fetch(`${base}/send_private_msg`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ user_id: OWNER, message: [{ type: 'text', data: { text: item.text } }] }),
      signal: AbortSignal.timeout(20000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.retcode !== 0) throw new Error(`HTTP ${res.status} retcode=${body.retcode} ${body.wording ?? ''}`);
    item.sentAt = Date.now();
    item.messageId = body.data?.message_id ?? null;
    log(`sent ${item.id}: ${item.text.slice(0, 40)}`);
  } catch (error) {
    log(`FAILED ${item.id}: ${error?.message ?? error}`);
    item.attempts = (item.attempts ?? 0) + 1;
    // 连续失败 5 次就作废，避免死循环刷日志
    if (item.attempts >= 5) item.failedAt = Date.now();
  }
}

state.items = (state.items ?? []).filter((x) => !(x.sentAt && Date.now() - x.sentAt > 30 * 86400000));
writeState(state);
