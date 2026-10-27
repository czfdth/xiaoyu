import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recordDrawingExperience, chooseDrawingBehavior, drawingScope, reflectToolObservation,
  learningView, learningHint, reviewLearning, LEARNING_TTL } from '../src/experience-learning.js';
import { runDrawingPlan } from '../src/drawing-fallback.js';
import { readJson } from '../src/state-store.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=','base64');
const attempts=[{provider:'comfyui',outcome:'failed',category:'unavailable',detail:'Bearer secret'}, {provider:'local_illustration',outcome:'succeeded'}];
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-learning-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'learning.json'),scope=drawingScope('comfyui',{comfyui:{baseUrl:'http://localhost:8188',checkpoint:'a'}});return {root,file,scope};}
function learn(f,at=1000){return recordDrawingExperience(f.file,{scope:f.scope,provider:'comfyui',attempts,at});}
function choose(f,more={}){return chooseDrawingBehavior(f.file,{scope:f.scope,provider:'comfyui',allowFallback:true,localSuitable:true,now:2000,...more});}

test('没有执行证据不产生经验；梦与自述不能变成策略',t=>{
 const f=setup(t);assert.equal(choose(f),null);
 for(const realityKind of ['imagined','self_report','reported']) assert.equal(reflectToolObservation(f.file,{id:'fake',realityKind,sourceType:'bridge_tool_result',ok:false,tool:'qq_draw',conversationKey:'private:1'}),null);
 assert.equal(fs.existsSync(f.file),false);
});
test('实际失败和成功形成有来源、有限期的反思，不保存凭据与原始聊天',t=>{
 const f=setup(t);learn(f);learn(f);
 const s=readJson(f.file);assert.equal(s.experiences.length,1);assert.equal(s.reflections.length,1);
 assert.equal(s.reflections[0].probeAt,1000+LEARNING_TTL);assert.equal(s.reflections[0].evidenceIds[0],s.experiences[0].id);
 assert.equal(learningHint(f.file,'private:1',2000,'different-config'),'');
 assert.match(learningHint(f.file,'private:1',2000,f.scope),/fallbackTemplate/);
 assert.doesNotMatch(JSON.stringify(s),/Bearer|secret/);
});
test('重读磁盘后实际改变下一次执行顺序，并记录采用结果',async t=>{
 const f=setup(t);learn(f);const called=[];
 const result=await runDrawingPlan({provider:'comfyui',learningFile:f.file,scope:f.scope,localSuitable:true,now:()=>2000,
  primary:async()=>{called.push('primary');throw new Error('fetch failed')},local:async()=>{called.push('local');return {buf:png}}});
 assert.deepEqual(called,['local']);assert.equal(result.learning.changedPlan,true);
 const s=readJson(f.file);assert.equal(s.applications[0].outcome,'generated');assert.equal(s.applications[0].localWorked,true);
 assert.equal(s.reflections[0].probeAt,1000+LEARNING_TTL); // Reuse cannot extend a circuit forever.
 assert(s.experiences.some(e=>e.id===s.applications[0].evidenceId));
});
test('规则过期或配置改变时恢复探测原服务，不永久困在备用',async t=>{
 const f=setup(t);learn(f);assert.equal(choose(f,{scope:'different'}),null);assert.equal(choose(f,{now:1000+LEARNING_TTL}),null);
 const called=[];const result=await runDrawingPlan({provider:'comfyui',learningFile:f.file,scope:f.scope,localSuitable:true,now:()=>1001+LEARNING_TTL,
  primary:async()=>{called.push('primary');return {buf:png}},local:async()=>assert.fail()});
 assert.deepEqual(called,['primary']);assert.equal(result.degraded,false);assert.equal(readJson(f.file).reflections[0].state,'resolved');
});
test('本地备用也失败时撤回经验，主服务仍有恢复机会',async t=>{
 const f=setup(t);learn(f);const called=[];
 await runDrawingPlan({provider:'comfyui',learningFile:f.file,scope:f.scope,localSuitable:true,now:()=>2000,
  local:async()=>{called.push('local');throw new Error('renderer failed')},primary:async()=>{called.push('primary');throw new Error('fetch failed')}}).catch(()=>{});
 assert.deepEqual(called,['local','primary']);assert.equal(readJson(f.file).reflections[0].state,'needs_review');assert.equal(choose(f),null);
 assert.equal(readJson(f.file).applications[0].outcome,'failed');
});
test('场景不适用、备用禁用、授权停用均不套用经验',t=>{
 const f=setup(t);const r=learn(f);assert.equal(choose(f,{localSuitable:false}),null);assert.equal(choose(f,{allowFallback:false}),null);
 reviewLearning(f.file,'private:1',{reflectionId:r.reflectionId,action:'disable',reason:'本地画风不适合当前任务'},2000);
 assert.equal(choose(f),null);learn(f,3000);assert.equal(choose(f,{now:4000}),null);
 reviewLearning(f.file,'private:1',{reflectionId:r.reflectionId,action:'enable',reason:'重新允许有限场景'},4000);assert(choose(f,{now:5000}));
 assert.equal(readJson(f.file).reviews.length,2);
});
test('缺少成功备用或只是配置错误时，不臆测换路一定有效',t=>{
 const f=setup(t);
 recordDrawingExperience(f.file,{scope:f.scope,provider:'comfyui',at:1000,attempts:attempts.slice(0,1)});assert.equal(choose(f),null);
 recordDrawingExperience(f.file,{scope:f.scope,provider:'comfyui',at:2000,attempts:[{...attempts[0],category:'configuration'},attempts[1]]});assert.equal(choose(f),null);
});
test('工具反思按会话隔离，不把失败概括成人格或用户态度',t=>{
 const f=setup(t);const e={id:'one',at:1000,realityKind:'tool_observation',sourceType:'bridge_tool_result',conversationKey:'group:2',tool:'qq_send_image',ok:false};
 reflectToolObservation(f.file,e);reflectToolObservation(f.file,e);
 assert.equal(learningView(f.file,'group:2',2000).experiences.length,1);
 assert.equal(learningView(f.file,'private:1',2000).reflections.length,0);assert.equal(learningHint(f.file,'private:1',2000),'');
 assert.match(learningHint(f.file,'group:2',2000),/回执/);
 assert.throws(()=>reviewLearning(f.file,'private:1',{reflectionId:readJson(f.file).reflections[0].id,action:'disable',reason:'跨会话'}),/其他会话/);
 reflectToolObservation(f.file,{...e,id:'two',at:2500,ok:true});assert.equal(learningView(f.file,'group:2',3000).reflections[0].state,'resolved');
});
test('经验文件损坏时保留原文件，提示与绘图执行仍能继续',async t=>{
 const f=setup(t);fs.writeFileSync(f.file,'damaged');assert.match(learningHint(f.file,'private:1'),/未覆盖/);
 const result=await runDrawingPlan({provider:'comfyui',learningFile:f.file,scope:f.scope,localSuitable:true,primary:async()=>({buf:png}),local:async()=>assert.fail()});
 assert(result.learningWarning);assert.equal(fs.readFileSync(f.file,'utf8'),'damaged');
});
test('机器配置作用域包含服务与模型，但不含 API 密钥或用户提示词',()=>{
 const cfg={comfyui:{baseUrl:'http://localhost:8188',checkpoint:'a',apiKey:'one'}};
 assert.equal(drawingScope('comfyui',cfg),drawingScope('comfyui',{comfyui:{...cfg.comfyui,apiKey:'two'}}));
 assert.notEqual(drawingScope('comfyui',cfg),drawingScope('comfyui',{comfyui:{...cfg.comfyui,checkpoint:'b'}}));
});
