import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAdaptiveOperation, digest, stateFingerprint } from '../src/adaptive-tools.js';
import { guardedDelivery, deliveryPayload, deliveryIntent } from '../src/delivery-guard.js';
import { recordDelivery } from '../src/deliveries.js';
import { readJson, writeJson } from '../src/state-store.js';
import { learningView } from '../src/experience-learning.js';
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-execution-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,file:path.join(root,'ops.json'),learningFile:path.join(root,'learning.json'),receiptsFile:path.join(root,'receipts.jsonl')};}
const operation=(f,more={})=>({file:f.learningFile,tool:'qq_project_workflow',key:'private:1',input:{action:'archive'},condition:'no-image',now:()=>1000,...more});
const sending=(f,more={})=>({...f,key:'private:1',intent:'incoming-1',condition:'gateway-A',request:{text:'hello'},now:()=>1000,...more});

test('项目失败后相同条件不会再次调用写入，读到新证据才恢复',async t=>{
 const f=setup(t);let calls=0;const execute=()=>{calls++;throw new Error('缺少证据')};
 await assert.rejects(runAdaptiveOperation(operation(f,{execute})),/缺少证据/);
 await assert.rejects(runAdaptiveOperation(operation(f,{execute})),/ADAPTIVE_PAUSED/);assert.equal(calls,1);
 const result=await runAdaptiveOperation(operation(f,{condition:'image-reviewed',execute:()=>{calls++;return {done:9}}}));
 assert.equal(result.done,9);assert.equal(calls,2);assert.equal(readJson(f.learningFile).reflections[0].state,'resolved');
 assert.equal(readJson(f.learningFile).applications[0].outcome,'not_reexecuted');
});
test('输入纠正与规则到期允许重新执行，不永久卡住约定',async t=>{
 const f=setup(t);await runAdaptiveOperation(operation(f,{execute:()=>{throw new Error('缺少回执')}})).catch(()=>{});
 assert.equal(await runAdaptiveOperation(operation(f,{input:{action:'archive',evidence:'new'},execute:()=>1})),1);
 assert.equal(await runAdaptiveOperation(operation(f,{now:()=>1801001,execute:()=>2})),2);
});
test('语音或草图服务失败后下一次换既定备用，能跨文本和进程状态重读',async t=>{
 const f=setup(t);let primary=0,backup=0;
 const base=operation(f,{tool:'tts_gpt_sovits',key:'machine',input:{text:'甲'},serviceInput:{engine:'gpt'},execute:()=>{primary++;throw new Error('fetch failed')},fallback:()=>{backup++;return 'edge'}});
 assert.equal(await runAdaptiveOperation(base),'edge');
 assert.equal(await runAdaptiveOperation({...base,input:{text:'乙'}}),'edge');assert.equal(primary,1);assert.equal(backup,2);
 const view=learningView(f.learningFile,'private:1',1001);assert.equal(view.applications.at(-1).chosen[0],'fallback');
 assert.equal(view.applications.at(-1).outcome,'fallback_succeeded');
 assert.equal(await runAdaptiveOperation({...base,now:()=>1801001,execute:()=>{primary++;return 'recovered'}}),'recovered');assert.equal(primary,2);
});
test('备用也失败后，条件未变时停止两条坏路的重复尝试',async t=>{
 const f=setup(t);let calls=0;const args=operation(f,{execute:()=>{calls++;throw new Error('fetch failed')},fallback:()=>{calls++;throw new Error('No module named PIL')}});
 await assert.rejects(runAdaptiveOperation(args),/No module/);assert.equal(calls,2);
 await assert.rejects(runAdaptiveOperation(args),/ADAPTIVE_PAUSED/);assert.equal(calls,2);
});
test('群聊错误不会暂停私聊；停用的普通经验不再拦截',async t=>{
 const f=setup(t);await runAdaptiveOperation(operation(f,{execute:()=>{throw new Error('缺少证据')}})).catch(()=>{});
 assert.equal(await runAdaptiveOperation(operation(f,{key:'group:2',execute:()=>2})),2);
 const s=readJson(f.learningFile);s.reflections[0].disabled=true;writeJson(f.learningFile,s);
 assert.equal(await runAdaptiveOperation(operation(f,{execute:()=>3})),3);
});
test('发送结果不明不会因时间、配置变化或停用经验而盲目重做',async t=>{
 const f=setup(t);const base=operation(f,{tool:'qq_say',intent:'owner-turn',execute:()=>{throw new Error('[DELIVERY_UNCERTAIN] timeout')}});
 await assert.rejects(runAdaptiveOperation(base),/DELIVERY_UNCERTAIN/);
 const s=readJson(f.learningFile);s.reflections[0].disabled=true;writeJson(f.learningFile,s);
 await assert.rejects(runAdaptiveOperation({...base,condition:'new-config',now:()=>999999999,execute:()=>assert.fail('不应重新合成再发送')}),/DELIVERY_UNCERTAIN/);
 assert.equal(await runAdaptiveOperation({...base,intent:'new-owner-request',condition:'new-config',execute:()=>1}),1);
});
test('损坏经验文件不覆盖旧数据，也不把写日志失败变成重复执行',async t=>{
 const f=setup(t);fs.writeFileSync(f.learningFile,'broken');let n=0;
 assert.equal(await runAdaptiveOperation(operation(f,{execute:()=>{n++;return 1}})),1);assert.equal(n,1);assert.equal(fs.readFileSync(f.learningFile,'utf8'),'broken');
});
test('证据内容改变而文件名不变，状态指纹也会改变',t=>{
 const f=setup(t),p=path.join(f.root,'image.png');fs.writeFileSync(p,'v1');const first=stateFingerprint([p]);fs.writeFileSync(p,'v2');assert.notEqual(first,stateFingerprint([p]));
});
test('成功发送后复用真实回执，不再次调用网关，学习日志也能看到调整',async t=>{
 const f=setup(t);let calls=0;const execute=async context=>{calls++;recordDelivery(f.receiptsFile,'send_private_msg',{user_id:1,message:[]},{message_id:123},1000,context);return {message_id:123}};
 assert.equal((await guardedDelivery(sending(f,{execute}))).message_id,123);
 const reused=await guardedDelivery(sending(f,{execute}));assert.equal(String(reused.message_id),'123');assert.equal(reused.adaptiveDelivery.reused,true);assert.equal(calls,1);
 assert.equal(learningView(f.learningFile,'private:1',1001).applications.at(-1).chosen[0],'reuse_receipt');
});
test('发送超时只能记为结果不明，重启后也不重发，不伪造成功',async t=>{
 const f=setup(t);let calls=0;const execute=()=>{calls++;throw new TypeError('fetch failed')};
 await assert.rejects(guardedDelivery(sending(f,{execute})),/DELIVERY_UNCERTAIN/);
 await assert.rejects(guardedDelivery(sending(f,{execute,now:()=>999999999,condition:'changed'})),/DELIVERY_UNCERTAIN/);assert.equal(calls,1);
 await assert.rejects(guardedDelivery(sending(f,{execute,intent:'new-incoming-message',now:()=>999999999})),/DELIVERY_UNCERTAIN/);assert.equal(calls,1);
 assert.equal(readJson(f.file).operations[0].status,'uncertain');assert.equal(readJson(f.file).operations[0].result,undefined);
});
test('发送落盘前进程中断：用已经保存的成功回执恢复，不再发一次',async t=>{
 const f=setup(t);writeJson(f.file,{operations:[{id:'crashed',key:'private:1',intent:'incoming-1',requestHash:digest({text:'hello'}),condition:'gateway-A',at:1000,status:'pending'}]});
 recordDelivery(f.receiptsFile,'send_private_msg',{user_id:1,message:[]},{message_id:456},1000,{operationId:'crashed',requestHash:digest({text:'hello'})});
 const r=await guardedDelivery(sending(f,{execute:()=>assert.fail()}));assert.equal(String(r.message_id),'456');assert.equal(readJson(f.file).operations[0].status,'succeeded');
});
test('没有成功回执的进行中请求停止重发；新输入不是旧请求',async t=>{
 const f=setup(t);writeJson(f.file,{operations:[{id:'pending',key:'private:1',intent:'incoming-1',requestHash:digest({text:'hello'}),at:1000,status:'pending'}]});
 await assert.rejects(guardedDelivery(sending(f,{execute:()=>assert.fail()})),/DELIVERY_PENDING/);
 const changed=await guardedDelivery(sending(f,{request:{text:'a different message'},execute:()=>({message_id:9})}));assert.equal(changed.message_id,9);
});
test('明确拒绝有短暂退避，过期后可再探测；HTTP 500 不当成明确未发送',async t=>{
 const f=setup(t);let calls=0;const execute=()=>{calls++;throw Object.assign(new Error('rejected'),{retcode:100})};
 await assert.rejects(guardedDelivery(sending(f,{execute})),/rejected/);
 await assert.rejects(guardedDelivery(sending(f,{execute})),/ADAPTIVE_PAUSED/);assert.equal(calls,1);
 await assert.rejects(guardedDelivery(sending(f,{execute,now:()=>31001})),/rejected/);assert.equal(calls,2);
 await assert.rejects(guardedDelivery(sending(f,{request:{text:'other'},execute:()=>{throw Object.assign(new Error('HTTP500'),{status:500})}})),/DELIVERY_UNCERTAIN/);
});
test('并发重试只能有一个真实发送，另一请求停下来核对',async t=>{
 const f=setup(t);let release;const pending=guardedDelivery(sending(f,{execute:()=>new Promise(r=>release=r)}));
 await assert.rejects(guardedDelivery(sending(f,{execute:()=>assert.fail()})),/DELIVERY_PENDING/);release({message_id:7});assert.equal((await pending).message_id,7);
});
test('同一批次两个相同气泡按位置区分，后续整批重试各自复用',async t=>{
 const f=setup(t);let calls=0;
 for(let pass=0;pass<2;pass++)for(let slot=0;slot<2;slot++) await guardedDelivery(sending(f,{request:{text:'重复',slot},execute:()=>({message_id:++calls})}));
 assert.equal(calls,2);
});
test('网关返回没有消息 ID 的成功不能算交付；损坏发送状态不能冒险发送',async t=>{
 const f=setup(t);await assert.rejects(guardedDelivery(sending(f,{execute:()=>({})})),/DELIVERY_UNCERTAIN/);
 fs.writeFileSync(f.file,'broken');await assert.rejects(guardedDelivery(sending(f,{execute:()=>assert.fail()})));assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
});
test('异步受理 retcode=1 不是明确拒绝，不能自动再次发送',async t=>{
 const f=setup(t);await assert.rejects(guardedDelivery(sending(f,{execute:()=>{throw Object.assign(new Error('async accepted'),{retcode:1})}})),/DELIVERY_UNCERTAIN/);
 await assert.rejects(guardedDelivery(sending(f,{execute:()=>assert.fail()})),/DELIVERY_UNCERTAIN/);
});
test('语音临时文件与等价 base64 的请求指纹一致；不保存音频内容',t=>{
 const f=setup(t),p=path.join(f.root,'voice.wav');fs.writeFileSync(p,'wave-content');
 const a=deliveryPayload({message:[{type:'record',data:{file:p}}]}),b=deliveryPayload({message:[{type:'record',data:{file:'base64://'+Buffer.from('wave-content').toString('base64')}}]});
 assert.deepEqual(a,b);assert.doesNotMatch(JSON.stringify(a),/wave-content/);
});
test('新收到的用户消息产生新发送意图，自身回复不会产生新意图',t=>{
 const f=setup(t),p=path.join(f.root,'social.json');writeJson(p,{conversations:{'private:1':{lastIncomingAt:10,recentMessages:[{messageId:1,isSelf:false}]}}});const before=deliveryIntent(p,'private:1');
 const s=readJson(p);s.conversations['private:1'].recentMessages.push({messageId:2,isSelf:true});writeJson(p,s);assert.equal(deliveryIntent(p,'private:1'),before);
 s.conversations['private:1'].lastIncomingAt=20;s.conversations['private:1'].recentMessages.push({messageId:3,isSelf:false});writeJson(p,s);assert.notEqual(deliveryIntent(p,'private:1'),before);
});
