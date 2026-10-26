import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { contentKind, narrativeRecord, recordToolObservation, readObservations, realityHint } from '../src/reality.js';
import { journalEvent, applyExtraction, promptMemories } from '../src/memory-attribution.js';
import { extractDay } from '../src/memory-extraction.js';
import { writeJson, readJson } from '../src/state-store.js';

test('消息是当事人陈述，日记是自述，梦和幻想不提升为观察',()=>{
  assert.equal(contentKind('我喜欢画画','owner'),'reported');
  assert.equal(contentKind('我刚刚在画画','her'),'self_report');
  assert.equal(contentKind('梦见鱼从画里游出来','her'),'imagined');
  assert.equal(contentKind('要是网络恢复，我就继续画画','her'),'self_report');
  assert.equal(narrativeRecord('diary',{text:'楼上有人跑步'}).realityKind,'self_report');
  assert.equal(narrativeRecord('dream',{}).realityKind,'imagined');
  assert.equal(narrativeRecord('fantasy',{}).realityKind,'imagined');
  assert.throws(()=>narrativeRecord('verified',{}));
});

test('梦境不能被模型重新打包成真实共同经历',()=>{
  const e=journalEvent({key:'private:1',role:'her',t:Date.now(),text:'梦见爸爸带我去海边'},1);
  const r=applyExtraction([],{add:[{text:'我们去海边了',type:'moment',subjectId:'self',sourceRefs:[e.eventId]}]},[e],'2026-10-26');
  assert.equal(r.rejected,1);assert.equal(r.items.length,0);
  assert.deepEqual(promptMemories([{type:'moment',text:'梦里去海边',realityKind:'imagined',conversationKey:'private:1'}],'private:1',1),[]);
});

test('失败原因按实际记录保存，不接受模型改写为手艺不好',()=>{
  const e=journalEvent({key:'private:1',role:'her',t:Date.now(),text:'qq_draw 实际返回失败：fetch failed',realityKind:'tool_observation',sourceType:'bridge_tool_result',toolOk:false},1);
  const r=applyExtraction([],{add:[{text:'画不出来因为手生',type:'moment',subjectId:'self',sourceRefs:[e.eventId]}]},[e],'2026-10-26');
  assert.equal(r.items[0].text,e.text);assert.equal(r.items[0].realityKind,'tool_observation');
});

test('工具观察按会话隔离，成功也不证明叙述内容真实',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-reality-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'events.jsonl');
  assert.equal(recordToolObservation(file,{type:'call',key:'private:1',tool:'qq_draw',ok:true}),null);
  recordToolObservation(file,{type:'result',time:new Date().toISOString(),key:'private:1',tool:'qq_draw',ok:false,error:'fetch failed'});
  recordToolObservation(file,{type:'result',time:new Date().toISOString(),key:'group:2',tool:'qq_draw',ok:true});
  assert.equal(readObservations(file,'private:1').length,1);
  const hint=realityHint(file,'private:1');assert.match(hint,/fetch failed/);assert.doesNotMatch(hint,/qq_draw: 工具返回成功/);
  assert.match(hint,/不能把断网改写成手艺不好/);
});

test('提炼能看到工具失败证据，而不只看到之后的自我解释',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-reality-extract-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  writeJson(path.join(dir,'memory/long-term.json'),{items:[]});
  recordToolObservation(path.join(dir,'reality-events.jsonl'),{type:'result',time:'2026-10-26T01:00:00Z',key:'private:1',tool:'qq_draw',ok:false,error:'network unavailable'});
  const r=await extractDay({stateDir:dir,ownerQQ:1,day:'2026-10-26',complete:async prompt=>{
    const e=JSON.parse(prompt.split('原始事件：\n')[1].split('\n只返回')[0])[0];
    assert.equal(e.realityKind,'tool_observation');
    return {add:[{text:'我手生',type:'moment',subjectId:'self',sourceRefs:[e.eventId]}],update:[]};
  }});
  assert.equal(r.processed,1);assert.match(readJson(path.join(dir,'memory/long-term.json')).items[0].text,/network unavailable/);
});
