import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeJson} from '../src/state-store.js';

test('实际生活时段脚本沿主目标推进，预算/停滞暂停时不另起活动',{timeout:20000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-agency-schedule-'));let held=false;const wakes=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  let data=req.url==='/api/status'?{mode:'reserved2',dshReady:true}:req.url.startsWith('/api/socialV2/state')?{agency:{hasGoals:true,next:held?null:{kind:'practice'},hold:held?'三次空转，先调整方法':null}}:{ok:true,accepted:true};
  if(req.url==='/api/socialV2/wake')wakes.push(JSON.parse(body));res.end(JSON.stringify(data));
 });});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 writeJson(path.join(root,'config.json'),{ownerQQ:10001,consolePort:server.address().port});fs.mkdirSync(path.join(root,'state'),{recursive:true});fs.writeFileSync(path.join(root,'state/console-token'),'fake-test-token');
 const run=async()=>{const child=spawn(process.execPath,['scripts/life-wake.mjs'],{cwd:process.cwd(),env:{...process.env,XIAOYU_HOME:root,XIAOYU_DATA:root,XIAOYU_STATE:path.join(root,'state')},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);const [code]=await once(child,'exit');assert.equal(code,0,log);return log;};
 await run();assert.equal(wakes.length,1);assert.equal(wakes[0].reason,'practice');
 held=true;assert.match(await run(),/skip/);assert.equal(wakes.length,1);
});
