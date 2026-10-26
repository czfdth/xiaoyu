// 只对已接受的唤醒请求计数，不把请求接受当作消息送达。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, STATE_DIR, STATE_FILES } from '../src/paths.js';
import { readJson, writeJson } from '../src/state-store.js';
import { runProactive, shanghaiDay } from '../src/autonomy.js';
import { projectView, nextProjectWork } from '../src/project-workflow.js';
import { listCommitments, dueCommitments } from '../src/commitments.js';
const log = text => fs.appendFileSync(path.join(STATE_DIR, 'proactive-nudge.log'), `[${new Date().toLocaleString('zh-CN')}] ${text}\n`);
const lock = path.join(STATE_DIR, 'proactive-run.lock');
let fd;
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') { fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); } }
    }
    if (fd === undefined) log('skip: 已有主动检查在运行');
  }
  if (fd !== undefined) {
    const cfg = readJson(CONFIG_FILE, {});
    if (!cfg.ownerQQ) throw new Error('没有用户身份');
    const now = Date.now(), day = shanghaiDay(now);
    const file = path.join(STATE_DIR, 'proactive-count.json');
    let counter = readJson(file, { day, count: 0 });
    if (counter.day !== day) counter = { day, count: 0 };
    const limits = cfg.limits || {};
    let spent = 0;
    if (limits.dailyTokens && fs.existsSync(STATE_FILES.tokenUsage)) {
      for (const line of fs.readFileSync(STATE_FILES.tokenUsage, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.t && shanghaiDay(e.t) === day && e.b) spent += ['cacheMiss','cacheHit','cacheWrite','output','reasoning'].reduce((sum, k) => sum + (Number(e.b[k]) || 0), 0);
      }
    }
    if ((limits.proactivePerDay && counter.count >= limits.proactivePerDay) || (limits.dailyTokens && spent >= limits.dailyTokens)) log('skip: 已达主动次数或 token 上限');
    else {
      const key = `private:${cfg.ownerQQ}`;
      const due = dueCommitments(listCommitments(STATE_FILES.commitments, STATE_FILES.longTermMemory, key, cfg.ownerQQ), now);
      const work = nextProjectWork(projectView(STATE_FILES.projects, key), key, now);
      const result = await runProactive({ key, counter, due, work, now,
        baseUrl: `http://127.0.0.1:${cfg.consolePort || 3100}`,
        headers: { 'x-console-token': fs.readFileSync(STATE_FILES.consoleToken, 'utf8').trim(), 'content-type': 'application/json' } });
      if (result.accepted) writeJson(file, result.counter);
      log(`${result.accepted ? 'accepted wake request（尚不代表发送或履约）' : 'skip/rejected'}: ${result.decision.reason}${result.httpStatus ? ` HTTP ${result.httpStatus}` : ''}`);
    }
  }
} catch (error) { log(`FAILED: ${error.message}`); process.exitCode = 1; }
finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
