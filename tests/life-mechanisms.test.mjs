import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { journalEvent, extractionBatches, applyExtraction, visibleMemory, promptMemories, engagement, resolvePromiseDue } from '../src/memory-attribution.js';
import { extractDay } from '../src/memory-extraction.js';
import { recordDelivery } from '../src/deliveries.js';
import { readJson, writeJson, updateJson } from '../src/state-store.js';
import { changeCommitment, listCommitments, dueCommitments, verifyArtifact } from '../src/commitments.js';
import { proactiveDecision, runProactive, shanghaiDay } from '../src/autonomy.js';

const now = Date.parse('2026-10-26T12:00:00+08:00');
const row = (key, role, text, extra = {}) => ({ key, role, text, t: now, ...extra });
const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-life-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('群友归属不等于用户；相同昵称在不同群也不合并', () => {
  const a = journalEvent(row('group:10', 'them', '别刷屏', { sender: '同名' }), 1);
  const b = journalEvent(row('group:20', 'them', '别刷屏', { sender: '同名' }), 1);
  assert.notEqual(a.speakerId, '1'); assert.notEqual(a.speakerId, b.speakerId);
  assert.equal(journalEvent(row('group:10','owner','x', { senderId: '999' }), 1).role, 'other');
});

test('归属验证拒绝把群友意见和她的猜测写成用户偏好', () => {
  const events = [journalEvent(row('group:10','them','别刷屏', { senderId: '2' }),1), journalEvent(row('group:10','her','他可能讨厌我'),1)];
  const r = applyExtraction([], { add: events.map(e => ({ text:'用户不喜欢我',type:'preference',subjectId:'1',sourceRefs:[e.eventId] })) }, events, '2026-10-26');
  assert.equal(r.rejected,2); assert.deepEqual(r.items,[]);
});

test('新记忆保存人物、会话和原话，不能跨会话注入', () => {
  const e = journalEvent(row('group:10','them','喜欢蓝色', { senderId:'2', messageId:'7' }),1);
  const r = applyExtraction([], { add:[{ text:'群友2喜欢蓝色',type:'preference',subjectId:'2',sourceRefs:[e.eventId] }] },[e],'2026-10-26');
  assert.equal(r.items[0].evidence[0].messageId,'7');
  assert.equal(visibleMemory(r.items[0], 'private:1', 1), false);
  assert.equal(visibleMemory(r.items[0], 'group:10', 1), true);
  assert.equal(visibleMemory({text:'旧摘要'}, 'group:10', 1), false);
  assert.equal(visibleMemory({text:'旧摘要'}, 'private:1', 1), true);
});

test('旧记忆与手动纠正不被模型随意覆盖，人物不同也不覆盖', () => {
  const old = { id:'legacy',text:'原有记忆',source:'manual' };
  const e=journalEvent(row('private:1','owner','新话'),1);
  const r=applyExtraction([old],{update:[{id:'legacy',text:'覆盖',type:'identity',subjectId:'1',sourceRefs:[e.eventId]}]},[e],'2026-10-26');
  assert.deepEqual(r.items,[old]); assert.equal(r.rejected,1);
});

test('旧资料原样保留，但来源未知的身份、偏好和纠正不再自动教给模型', () => {
  const items=[{id:'a',type:'identity',text:'他叫旧名'}, {id:'b',type:'correction',text:'群友的话被记成用户要求'},
    {id:'c',type:'moment',text:'一起猜中37'}, {id:'d',type:'preference',text:'当事人亲口说喜欢蓝色',conversationKey:'private:1',subjectId:'1'}];
  const saved=JSON.stringify(items);
  assert.deepEqual(promptMemories(items,'private:1',1).map(e=>e.id),['c','d']);
  assert.equal(JSON.stringify(items),saved);
});

test('分批处理不会让活跃群挤掉私聊或截掉一天较早的事件', () => {
  const input=[row('private:1','owner','早上的约定'), ...Array.from({length:400},(_,i)=>row('group:10','them','群消息'+i,{ t:now+i+1 }))];
  const batches=extractionBatches(input,1,1000);
  assert.equal(batches.flat().length,401);
  assert(batches.every(b=>new Set(b.map(e=>e.conversationKey)).size===1));
  assert(batches.flat().some(e=>e.text==='早上的约定'));
});

test('互动统计只关联同会话，而且不把邻近回复叫作有效反馈', () => {
  const events=[journalEvent(row('group:10','her','群消息'),1), journalEvent(row('private:1','owner','私聊回复',{t:now+1000}),1)];
  assert.equal(engagement(events).temporalPairs.length,0);
  assert.match(engagement(events).warning,/不能证明/);
});

test('明天以原话日期为准，即使次日提炼也不再顺延', () => {
  const event={ text:'明天给你画一张',eventAt:Date.parse('2026-10-24T23:30:00+08:00') };
  assert.equal(shanghaiDay(resolvePromiseDue(null,[event])), '2026-10-25');
  assert.equal(shanghaiDay(resolvePromiseDue('2026-10-27T12:00:00+08:00',[event])), '2026-10-25');
});

test('模型失败不推进批次；重试接续且保留旧数据', async t => {
  const root=fixture(t), stateDir=path.join(root,'state'), file=path.join(stateDir,'memory/long-term.json');
  writeJson(file,{items:[{id:'legacy',text:'原有记忆'}]});
  fs.mkdirSync(path.join(stateDir,'journal'),{recursive:true});
  fs.writeFileSync(path.join(stateDir,'journal/2026-10-26.jsonl'),[row('private:1','owner','喜欢蓝色'),row('group:10','them','喜欢绿色',{senderId:'2'})].map(r=>JSON.stringify(r)).join('\n'));
  let calls=0;
  const complete=async prompt=>{
    calls++; if(calls===2)throw new Error('模拟模型断网');
    const events=JSON.parse(prompt.split('原始事件：\n')[1].split('\n只返回')[0]);
    const e=events[0];return {add:[{text:e.text,type:'preference',subjectId:e.speakerId,sourceRefs:[e.eventId]}],update:[]};
  };
  await assert.rejects(extractDay({stateDir,ownerQQ:1,day:'2026-10-26',complete}),/断网/);
  assert.equal(readJson(file).items.length,2);
  const result=await extractDay({stateDir,ownerQQ:1,day:'2026-10-26',complete});
  assert.equal(result.processed,1); assert.equal(readJson(file).items.length,3);
  assert.deepEqual(readJson(file).items[0],{id:'legacy',text:'原有记忆'});
  assert.equal((await extractDay({stateDir,ownerQQ:1,day:'2026-10-26',complete})).processed,0);
});

function commitmentFixture(t) {
  const root=fixture(t),file=path.join(root,'state/commitments.json'),memory=path.join(root,'state/memory/long-term.json');
  writeJson(memory,{items:[{id:'old',type:'promise',text:'明天画画'}]});
  const context={root,now,messages:[{messageId:'11',isSelf:true,text:'答应你画画',time:now},{messageId:'12',isOwner:true,text:'好',time:now}]};
  const change=input=>changeCommitment(file,memory,'private:1',1,input,context);
  return {root,file,memory,context,change};
}

test('旧承诺保留并标待核实，不自动判失约，不自动执行', t => {
  const f=commitmentFixture(t),items=listCommitments(f.file,f.memory,'private:1',1);
  assert.equal(items[0].status,'needs_review'); assert.deepEqual(dueCommitments(items,now),[]);
  assert.throws(()=>f.change({id:'memory:old',status:'pending'}),/核实/);
  assert.equal(fs.existsSync(f.file),false);
});

test('承诺跨读取保留，完成需要作品与真实交付证据，失败不结案',t=>{
  const f=commitmentFixture(t);
  const item=f.change({text:'给你画一张鱼',sourceMessageId:'11',dueAt:'2026-10-26T11:00:00+08:00'});
  assert.equal(listCommitments(f.file,f.memory,'private:1',1).find(e=>e.id===item.id).status,'pending');
  assert.equal(dueCommitments(listCommitments(f.file,f.memory,'private:1',1),now).length,1);
  assert.throws(()=>f.change({id:item.id,status:'completed',deliveredMessageId:'999'}),/成功发送/);
  assert.throws(()=>f.change({id:item.id,status:'completed',deliveredMessageId:'11'}),/原话/);
  assert.equal(readJson(f.file).items[0].status,'pending');
  fs.mkdirSync(path.join(f.root,'images'));fs.writeFileSync(path.join(f.root,'images/fish.png'),'test-image');
  assert.throws(()=>f.change({id:item.id,status:'completed',evidencePath:'images/fish.png'}),/证据/);
  const receipt = recordDelivery(path.join(f.root,'state/receipts.jsonl'),'send_private_msg',{user_id:1,message:[{type:'image',data:{file:'base64://' + Buffer.from('test-image').toString('base64')}}]},{message_id:13},now+10000);
  f.context.messages.push(receipt);
  const done=f.change({id:item.id,status:'completed',evidencePath:'images/fish.png',deliveredMessageId:'13'});
  assert.equal(done.status,'completed'); assert.equal(done.evidence.length,2);
  assert.equal(dueCommitments([done],now).length,0);
  assert.throws(()=>f.change({id:item.id,status:'pending'}),/结案/);
});

test('承诺受阻必须留原因；可重新安排；群友不能冒充用户承诺',t=>{
  const f=commitmentFixture(t),item=f.change({text:'练习画鱼',sourceMessageId:'11',deliveryRequired:false});
  assert.throws(()=>f.change({id:item.id,status:'blocked'}),/原因/);
  assert.equal(f.change({id:item.id,status:'blocked',note:'画图断网，稍后重试'}).status,'blocked');
  assert.equal(f.change({id:item.id,status:'pending',dueAt:'2026-10-27T12:00:00+08:00'}).dueAt,now+86400000);
  f.context.messages.push({messageId:'30',isOwner:false,isSelf:false});
  assert.throws(()=>f.change({text:'替爸爸答应',sourceMessageId:'30'}),/群友/);
});

test('证据不能读取配置和库外文件，承诺不能跨会话修改',t=>{
  const f=commitmentFixture(t);fs.writeFileSync(path.join(f.root,'config.json'),'secret');
  assert.throws(()=>verifyArtifact(f.root,'config.json'),/本项目/);
  const item=f.change({text:'画鱼',sourceMessageId:'11'});
  assert.throws(()=>changeCommitment(f.file,f.memory,'group:10',1,{id:item.id,status:'cancelled'},f.context),/找不到/);
});

const ready={mode:'reserved2',dshReady:true,socialV2Paused:false,snowluma:{connected:true}};
const quiet={ok:true,lastIncomingAt:now-600000,lastAiReplyAt:now-600000,unreadCount:0};
test('主动检查对缺失时间、刚来信、未读、离线和安静时段保持安静',()=>{
  for (const state of [{...quiet,lastIncomingAt:undefined},{...quiet,lastIncomingAt:0},{...quiet,lastIncomingAt:now-1000},{...quiet,unreadCount:1}]) {
    assert.equal(proactiveDecision({status:ready,state,now,random:0}).ok,false);
  }
  assert.equal(proactiveDecision({status:{...ready,snowluma:{connected:false}},state:quiet,now,random:0}).ok,false);
  assert.equal(proactiveDecision({status:ready,state:quiet,now:Date.parse('2026-10-26T03:00:00+08:00'),random:0}).ok,false);
});

test('到期自己的承诺优先，但不会催用户的承诺和反复唤醒同一任务',()=>{
  const due=[{id:'x',status:'pending',promisor:'self',dueAt:now-1000}];
  assert.equal(proactiveDecision({status:ready,state:quiet,now,random:1,due}).reason,'commitment');
  assert.equal(proactiveDecision({status:ready,state:quiet,now,random:0,due,counter:{lastCommitmentId:'x',lastCommitmentWakeAt:now-1000}}).ok,false);
  assert.equal(dueCommitments([{...due[0],promisor:'1'}],now).length,0);
});

test('唤醒拒绝、离线或 HTTP 失败不改变每日计数；接受也不等于交付',async()=>{
  const counter={day:'2026-10-26',count:3};
  for(const failure of [403,500]){
    const mock=async url=>url.endsWith('/api/status')?Response.json(ready):url.includes('/state?')?Response.json(quiet):Response.json({ok:false},{status:failure});
    const r=await runProactive({baseUrl:'http://fake',key:'private:1',headers:{},counter,now,random:0,fetchImpl:mock});
    assert.equal(r.accepted,false);assert.equal(counter.count,3);
  }
  const mock=async url=>Response.json(url.endsWith('/api/status')?ready:url.includes('/state?')?quiet:{ok:true,accepted:true,completed:false});
  const r=await runProactive({baseUrl:'http://fake',key:'private:1',headers:{},counter,now,random:0,fetchImpl:mock});
  assert.equal(r.counter.count,4);assert.equal(counter.count,3);assert.match(r.counter.meaning,/not_delivered/);
  let n=0;
  const offline=await runProactive({baseUrl:'http://fake',key:'private:1',headers:{},counter,now,random:0,fetchImpl:async()=>{n++;return Response.json({...ready,snowluma:{connected:false}});}});
  assert.equal(offline.accepted,false);assert.equal(n,1);
});

test('上海午夜切日与 UTC 不混用',()=>assert.equal(shanghaiDay(Date.parse('2026-10-26T00:10:00+08:00')),'2026-10-26'));

test('原子写入失败保留旧数据，损坏文件不静默清空',t=>{
  const root=fixture(t),file=path.join(root,'state.json');writeJson(file,{value:1});
  assert.throws(()=>updateJson(file,{},()=>{throw new Error('fail');}),/fail/);
  assert.deepEqual(readJson(file),{value:1});
  fs.writeFileSync(file,'corrupt');assert.throws(()=>readJson(file,{}));
});
