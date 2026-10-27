// 生活时段唤醒来一下：让她自己过一会儿，做点自己的事。
import { APP_ROOT as ROOT, STATE_FILES } from '../src/paths.js';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(ROOT + '/config.json', 'utf8').replace(/^\uFEFF/, ''));
const OWNER = Number(cfg.ownerQQ) || 0;

const tok = fs.readFileSync(STATE_FILES.consoleToken, 'utf8').trim();
if (!OWNER) throw new Error('没有用户身份，不能唤醒');
const base = `http://127.0.0.1:${cfg.consolePort || 3100}`;
const statusResponse = await fetch(base + '/api/status', { headers: { 'x-console-token': tok }, signal: AbortSignal.timeout(10000) });
if (!statusResponse.ok) throw new Error('状态查询失败');
const status = await statusResponse.json();
if (status.mode !== 'reserved2' || status.socialV2Paused || !status.dshReady) {
  console.log('skip: 大脑尚未就绪，不安排独立活动');
  process.exit(0);
}

const stateResponse=await fetch(base+'/api/socialV2/state?key='+encodeURIComponent(`private:${OWNER}`),{headers:{'x-console-token':tok},signal:AbortSignal.timeout(10000)});
if(!stateResponse.ok)throw new Error('独立目标状态查询失败');
const state=await stateResponse.json();
let reason='life';
if(state.agency?.hasGoals){
  if(!state.agency.next){console.log('skip: '+(state.agency.hold||'当前目标暂不可推进'));process.exit(0);}
  reason=state.agency.next.kind;
}

const r = await fetch(base + '/api/socialV2/wake', {
  method: 'POST',
  signal: AbortSignal.timeout(10000),
  headers: { 'x-console-token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ key: `private:${OWNER}`, reason })
});
const result = await r.json();
if (!r.ok || !result.ok || !result.accepted) throw new Error(`生活唤醒未被接受 HTTP ${r.status}`);
console.log(new Date().toLocaleString('zh-CN'), 'life wake accepted（不代表已完成活动）');
