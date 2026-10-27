import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDrawingPlan, drawError, chooseLocalTemplate } from '../src/drawing-fallback.js';
const buf=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=','base64');
test('服务拒绝连接后只切换一次，记录真实原因和实际提供方',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'draw-plan-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let calls=0;const logFile=path.join(root,'attempts.jsonl');
 const result=await runDrawingPlan({provider:'comfyui',logFile,primary:async()=>{throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}})},local:async()=>{calls++;return {buf,ext:'.png'}}});
 assert.equal(calls,1);assert.equal(result.provider,'local_illustration');assert.equal(result.degraded,true);
 assert.equal(result.attempts[0].category,'unavailable');assert.match(result.attempts[0].detail,/ECONNREFUSED/);
 assert.equal(fs.readFileSync(logFile,'utf8').trim().split('\n').length,2);
});
test('主服务成功不调用备用服务',async()=>{
 const result=await runDrawingPlan({provider:'comfyui',primary:async()=>({buf}),local:async()=>assert.fail('不该生成第二张')});
 assert.equal(result.degraded,false);assert.equal(result.attempts.length,1);
});
test('伪图片和超时均能换路',async()=>{
 for(const primary of [async()=>({buf:Buffer.from('html')}),async()=>{throw new Error('timeout')}]){
  const result=await runDrawingPlan({provider:'comfyui',primary,local:async()=>({buf})});assert.equal(result.degraded,true);
 }
});
test('禁用备用或两路都失败时不无限重试',async()=>{
 let calls=0;const fail=async()=>{calls++;throw new Error('timeout')};
 await assert.rejects(runDrawingPlan({provider:'comfyui',primary:fail,local:fail,allowFallback:false}),/所有绘图方式/);assert.equal(calls,1);
 calls=0;await assert.rejects(runDrawingPlan({provider:'comfyui',primary:fail,local:fail}),e=>e.attempts.length===2);assert.equal(calls,2);
});
test('审计写入失败不会重复生成或丢失成功结果',async()=>{
 let calls=0;const result=await runDrawingPlan({provider:'comfyui',logFile:path.join(import.meta.filename,'impossible.jsonl'),primary:async()=>{calls++;return {buf}},local:async()=>assert.fail()});
 assert.equal(calls,1);assert.equal(result.provider,'comfyui');assert(result.auditWarning);
});
test('错误记录隐藏凭据；场景选择保留书桌主题',()=>{
 assert.doesNotMatch(drawError(new Error('Bearer abcd token=private sk-supersecret')).detail,/abcd|private|supersecret/);
 assert.equal(chooseLocalTemplate('傍晚书桌，鲸鱼女孩握着笔'),'desk');
});
