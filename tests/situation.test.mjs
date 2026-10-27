import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inferSituation,situationView,contextualContinuity,executeSituationSend,observeSituation,wakeSituationDecision} from '../src/situation.js';
import {readJson} from '../src/state-store.js';
import {runAdaptiveOperation} from '../src/adaptive-tools.js';

function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-situation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'situation.json'),key='private:1';let now=Date.now(),seq=0,calls=0;
 const state={recentMessages:[]};
 const incoming=(text,more={})=>{const msg={messageId:String(++seq),plain:text,time:now,userId:'1',isOwner:true,...more};state.lastIncomingAt=now;state.recentMessages.push(msg);observeSituation(file,key,msg,'1',now);return msg;};
 return {file,key,state,dir,incoming,tick:n=>now+=n,get now(){return now},get calls(){return calls},
 view:()=>situationView(file,key,state,now),send:(messages,extra={})=>executeSituationSend({file,key,state,messages,now:()=>now,execute:async()=>({message_id:++calls}),...extra}),
 wake:reason=>wakeSituationDecision(file,key,state,reason,now)};
}

for(const [quote,need] of [['我今天好累','listen'],['不要给建议，只想吐槽','listen'],['帮我分析怎么解决','solve'],['帮我写一段代码','execute'],['先这样，晚安','closing'],['嗯','brief'],['假如我说好累','unknown'],['朋友说他累','unknown']])test('情境线索：'+quote,()=>{
 const now=Date.now();assert.equal(inferSituation({quote,at:now,isOwner:true},now).need,need);
});
test('倾诉：拦建议和追问，允许一次简短回应，表情也不能追加',async t=>{
 const f=setup(t);f.incoming('今天下雨了');await assert.rejects(f.send(['建议你先运动']),/SITUATION_PAUSED/);f.incoming('我今天好累');
 await assert.rejects(f.send(['建议你先运动，再早睡']),/SITUATION_PAUSED/);
 await assert.rejects(f.send(['要不要聊聊？']),/SITUATION_PAUSED/);assert.equal(f.calls,0);
 await f.send(['今天辛苦了，我听着。']);await assert.rejects(f.send([]),/SITUATION_PAUSED/);assert.equal(f.calls,1);
});
test('明确请求建议可执行；关键问题只问一次，新来信开启新一轮',async t=>{
 const f=setup(t);f.incoming('帮我分析这个报错怎么解决');await f.send(['错误原文是什么？']);
 await assert.rejects(f.send(['你遇到了什么错误呢？']),/SITUATION_PAUSED/);
 f.incoming('报错是找不到文件');await f.send(['建议你先核对文件路径']);assert.equal(f.calls,2);
});
test('显式访谈允许多个问题，普通聊天不会如此',async t=>{
 const f=setup(t);f.incoming('问我三个问题');assert.equal(f.view().maxQuestions,3);
 await f.send(['最近看什么书？今天做什么了？最喜欢什么颜色？']);assert.equal(f.calls,1);
});
test('原话过期不永久锁定倾诉模式',t=>{
 const f=setup(t);f.incoming('晚安');f.tick(31*60000);assert.equal(f.view().need,'unknown');assert.equal(f.view().contextValid,false);
});
test('主动联系未回应时不再发送；内部练习仍能唤醒',async t=>{
 const f=setup(t);f.incoming('今天聊些别的');f.state.autonomousWake=true;await f.send(['我完成了画册草稿。']);
 await assert.rejects(f.send(['再分享一件事']),/SITUATION_PAUSED/);assert.equal(f.wake('proactiveCheck').ok,false);assert.equal(f.wake('replyCheck').ok,false);assert.equal(f.wake('practice').ok,true);
 f.incoming('说说画了什么');f.state.autonomousWake=false;await f.send(['画的是窗边的小鱼。']);assert.equal(f.calls,2);
});
test('并发不同内容也预留额度，避免连发绕过',async t=>{
 const f=setup(t);f.incoming('我很累');let release;const pending=f.send(['我听你说。'],{execute:()=>new Promise(r=>release=r)});
 await assert.rejects(f.send(['再陪你一下']),/SITUATION_PAUSED/);release({message_id:9});await pending;
});
test('未知内容语音不能绕过倾诉检查，有正文可正常发送',async t=>{
 const f=setup(t);f.incoming('只想吐槽');await assert.rejects(f.send([],{voiceUnknown:true}),/SITUATION_PAUSED/);
 await f.send(['我听着。']);assert.equal(f.calls,1);
});
test('明确反馈关联实际动作，之后自动缩减建议；沉默不生成负评',async t=>{
 const f=setup(t);f.incoming('帮我建议怎么休息');await f.send(['建议你先休息']);f.tick(1000);f.incoming('不要总给建议');
 const c=f.view().calibrations.at(-1);assert.equal(c.kind,'over_advice');assert.ok(c.targetActionId);
 f.tick(1000);f.incoming('今天事情真多');assert.equal(f.view().need,'listen');await assert.rejects(f.send(['你应该先安排一下']),/SITUATION_PAUSED/);
 const count=f.view().calibrations.length;f.tick(60000);f.view();assert.equal(f.view().calibrations.length,count);
 f.incoming('现在帮我分析怎么解决');await f.send(['建议你先列出截止时间']);
});
test('无对应执行时仅记边界，不冒称纠正了具体失误',t=>{
 const f=setup(t);f.incoming('别再问了');const c=f.view().calibrations.at(-1);assert.equal(c.targetActionId,null);assert.equal(c.result,'explicit_boundary_without_matching_execution');
});
test('明确减少主动联系会执行冷却，直接新请求仍可回答',async t=>{
 const f=setup(t);f.incoming('别再主动找我了');assert.equal(f.wake('proactiveCheck').ok,false);
 f.state.autonomousWake=true;await assert.rejects(f.send(['新话题']),/SITUATION_PAUSED/);
 f.incoming('帮我解释这段代码');f.state.autonomousWake=false;await f.send(['这段代码在读取文件']);assert.equal(f.calls,1);
});
test('反对机械套用偏好会实际停用旧语气画风，保留联系及人物边界',t=>{
 const f=setup(t);f.incoming('别总按以前偏好');
 const v={policy:{maxTextChars:120,proactiveDisabled:true,avoidLocalTemplates:true},activeFeedback:[{id:'a',dimension:'detail'},{id:'b',dimension:'art_style'},{id:'c',dimension:'character'},{id:'d',dimension:'art_style',policy:{avoidLocalTemplates:true}}]};
 const effective=contextualContinuity(v,f.view());assert.equal(effective.policy.maxTextChars,null);assert.deepEqual(effective.activeFeedback.map(f=>f.id),['c','d']);assert.equal(effective.policy.proactiveDisabled,true);assert.equal(effective.policy.avoidLocalTemplates,true);
 f.tick(31*60000);assert.equal(contextualContinuity(v,f.view()).policy.maxTextChars,120);
});
test('非主人、玩笑、转述不形成主人的校准',t=>{
 const f=setup(t);f.incoming('不要给建议',{isOwner:false,userId:'2'});f.incoming('假如我说别问了');f.incoming('朋友说不要建议');assert.equal(f.view().calibrations.length,0);
});
test('认可只关联本次实际回复，不推断已读或长期满意',async t=>{
 const f=setup(t);f.incoming('聊聊');await f.send(['今天画好了草稿']);f.tick(1000);f.incoming('这样就好');assert.equal(f.view().calibrations.at(-1).result,'user_explicitly_approved_this_response_only');
});
test('仅当次表达偏好可覆盖；长期偏好、安静和身份权限不改写',t=>{
 const f=setup(t);const v={policy:{maxTextChars:120,maxBubbles:1,proactiveDisabled:true,forbiddenNames:['宝宝'],avoidLocalTemplates:true},activeFeedback:[{id:'short',policy:{maxTextChars:120}},{id:'art',dimension:'art_style',policy:{}}]};const before=JSON.stringify(v);
 f.incoming('这次详细解释，分几条说，这次用水彩');const effective=contextualContinuity(v,f.view());assert.equal(effective.policy.maxTextChars,null);assert.equal(effective.policy.maxBubbles,null);assert.equal(effective.policy.proactiveDisabled,true);assert.equal(effective.policy.avoidLocalTemplates,true);assert.deepEqual(effective.policy.forbiddenNames,['宝宝']);assert.equal(JSON.stringify(v),before);
 f.incoming('你好');assert.equal(contextualContinuity(v,f.view()).policy.maxTextChars,120);
 f.incoming('这次详细解释',{isOwner:false,userId:'2'});assert.equal(contextualContinuity(v,f.view()).policy.maxTextChars,120);
});
test('过期或假设例外无效；明确本次模板许可仅本次放行',t=>{
 const f=setup(t),v={policy:{avoidLocalTemplates:true},activeFeedback:[]};
 f.incoming('假如这次可以用模板');assert.equal(contextualContinuity(v,f.view()).policy.avoidLocalTemplates,true);
 f.incoming('这次可以用模板');assert.equal(contextualContinuity(v,f.view()).policy.avoidLocalTemplates,false);f.tick(31*60000);assert.equal(contextualContinuity(v,f.view()).policy.avoidLocalTemplates,true);
});
test('不同会话互不消耗额度，校准不串人',async t=>{
 const f=setup(t);f.incoming('今天好累');await f.send(['我听着。']);await executeSituationSend({file:f.file,key:'private:2',state:f.state,messages:['我听着。'],execute:async()=>({message_id:3})});assert.equal(situationView(f.file,'private:2',f.state).actions.length,1);
});
test('发送成功后审计失败不重发，损坏文件不覆盖',async t=>{
 const f=setup(t);f.incoming('聊聊');let actual=0;const result=await f.send(['你好'],{execute:async()=>{actual++;fs.writeFileSync(f.file,'broken');return {message_id:501};}});assert.equal(result.message_id,501);assert.equal(actual,1);await assert.rejects(f.send(['你好']));assert.equal(fs.readFileSync(f.file,'utf8'),'broken');assert.equal(f.calls,0);
});
test('情境暂停不成为工具故障，不触发备用发送',async t=>{
 const f=setup(t);let fallback=0;await assert.rejects(runAdaptiveOperation({file:path.join(f.dir,'learning.json'),key:f.key,tool:'qq_say',input:{},condition:'x',execute:async()=>{throw new Error('[SITUATION_PAUSED] 请等待')},fallback:async()=>fallback++}),/SITUATION_PAUSED/);assert.equal(fallback,0);assert.equal(fs.existsSync(path.join(f.dir,'learning.json')),false);
});
