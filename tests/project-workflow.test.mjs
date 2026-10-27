import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { changeProject, projectView, nextProjectWork, projectHint } from '../src/project-workflow.js';
import { readJson, writeJson } from '../src/state-store.js';
import { proactiveDecision } from '../src/autonomy.js';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=','base64');
function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-project-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state/projects.json'),key='private:1';
  writeJson(file,{active:'album',items:[{id:'album',title:'画册',kind:'drawing',done:8,total:20,note:'原有记录'}]});
  const context={root,now:Date.now(),messages:[],observations:[]};
  const change=input=>changeProject(file,key,input,context);
  const image=(name,version=0)=>{fs.mkdirSync(path.join(root,'images'),{recursive:true});fs.writeFileSync(path.join(root,'images',name),Buffer.concat([PNG,Buffer.from([version])]));return 'images/'+name;};
  return {root,file,key,context,change,image};
}

test('从旧进度8/20开始第9页，重复start不会新建或修改主题',t=>{
  const f=setup(t),first=f.change({action:'start',brief:'一条蓝鲸游过月亮'});
  assert.equal(first.task.pageNumber,9);assert.equal(first.done,8);
  const second=f.change({action:'start',brief:'另一个主题'});
  assert.equal(second.task.id,first.task.id);assert.equal(second.task.brief,first.task.brief);
  assert.equal(readJson(f.file).items[0].note,'原有记录');
});

test('没有作品不能跳检查和归档，自检不冒充用户认可',t=>{
  const f=setup(t);f.change({action:'start',brief:'鱼与月亮'});
  assert.throws(()=>f.change({action:'archive'}),/没有通过检查/);
  assert.throws(()=>f.change({action:'review',verdict:'accept',note:'不错'}),/实际草稿/);
  f.change({action:'attach',evidencePath:f.image('v1.png')});
  assert.throws(()=>f.change({action:'review',verdict:'accept'}),/具体理由/);
  const review=f.change({action:'review',verdict:'accept',note:'构图清楚、主体完整，颜色符合选题',checks:[{id:'c1',passed:true,note:'实际检查主体构图和要求'}]});
  assert.equal(review.task.versions[0].review.kind,'agent_self_review');
  assert.equal(review.done,8);
});

test('修改保留每一版和用户原话；完成归档只计一次，重读后接续',t=>{
  const f=setup(t),start=f.change({action:'start',brief:'鲸鱼练习'});
  f.change({action:'attach',evidencePath:f.image('v1.png')});
  f.context.messages.push({messageId:'2',isOwner:true,isSelf:false,text:'尾巴太小，放大一些',time:f.context.now+1});
  f.change({action:'review',verdict:'revise',note:'放大尾巴',feedbackMessageId:'2'});
  const saved=projectView(f.file,f.key)[0].workflow.tasks[0];
  assert.equal(saved.stage,'revise');assert.equal(saved.versions[0].review.feedback.text,'尾巴太小，放大一些');
  assert.match(projectHint(projectView(f.file,f.key)),/放大尾巴/);
  assert.throws(()=>f.change({action:'attach',evidencePath:'images/v1.png'}),/同一件作品/);
  f.change({action:'attach',evidencePath:f.image('v2.png',1)});
  f.change({action:'review',verdict:'accept',note:'第二版尾巴比例已经调整，主体完整',checks:[{id:'c1',passed:true,note:'实际检查主体构图和要求'},{id:'message:2',passed:true,note:'实际检查主体构图和要求'}]});
  f.change({action:'archive'});f.change({action:'archive',taskId:start.task.id});
  const p=readJson(f.file).items[0];assert.equal(p.done,9);assert.equal(p.artifacts.length,1);
  assert.equal(p.workflow.tasks[0].versions.length,2);assert(fs.existsSync(path.join(f.root,'images/v1.png')));
  assert.equal(nextProjectWork(projectView(f.file,f.key),f.key,f.context.now),null);
  assert.throws(()=>f.change({action:'start',brief:'下一张'}),/休息/);
  f.context.messages.push({messageId:'old',isOwner:true,text:'昨天的请求',time:f.context.now-1000});
  assert.throws(()=>f.change({action:'start',brief:'不能重用旧要求',sourceMessageId:'old'}),/休息/);
  f.context.now+=1800001;assert.equal(f.change({action:'start',brief:'下一张'}).task.pageNumber,10);
});

test('实际断网原因保留，重试等待半小时，三次失败后需要用户决定',t=>{
  const f=setup(t);f.change({action:'start',brief:'鲸鱼'});
  f.context.observations.push({id:'err',conversationKey:f.key,tool:'qq_draw',ok:false,detail:'fetch failed',at:f.context.now});
  const b=f.change({action:'block',note:'稍后再画',failureEventId:'err'});
  assert.equal(b.task.lastError,'qq_draw: fetch failed');assert.equal(b.done,8);
  assert.equal(b.task.errorSource,'tool_observation');
  assert.equal(f.change({action:'block',note:'重试记录同一失败',failureEventId:'err'}).task.failures,1);
  assert.equal(nextProjectWork(projectView(f.file,f.key),f.key,f.context.now),null);
  assert.throws(()=>f.change({action:'resume'}),/重试时间/);
  f.context.now+=1800001;
  assert.equal(nextProjectWork(projectView(f.file,f.key),f.key,f.context.now).nextAction,'resume');
  f.change({action:'resume'});f.change({action:'block',note:'第二次网络失败'});
  f.context.now+=1800001;f.change({action:'resume'});f.change({action:'block',note:'第三次网络失败'});
  assert.equal(nextProjectWork(projectView(f.file,f.key),f.key,f.context.now+86400000),null);
  assert.throws(()=>f.change({action:'resume'}),/用户/);
  f.context.messages.push({messageId:'go',isOwner:true,text:'换个办法继续',time:f.context.now+1});
  assert.equal(f.change({action:'resume',sourceMessageId:'go'}).task.stage,'generate');
});

test('三版仍需修改时停止生成，用户确认后才能再尝试一版',t=>{
  const f=setup(t);f.change({action:'start',brief:'练习'});
  for(let i=0;i<3;i++){f.change({action:'attach',evidencePath:f.image(`v${i}.png`,i)});f.change({action:'review',verdict:'revise',note:'仍需要调整尾巴'});}
  assert.equal(readJson(f.file).items[0].workflow.tasks[0].needsHelp,true);
  assert.throws(()=>f.change({action:'resume'}),/用户/);
  f.context.messages.push({messageId:'go',isOwner:true,text:'再试一张',time:f.context.now+1});
  f.change({action:'resume',sourceMessageId:'go'});
  assert.equal(f.change({action:'attach',evidencePath:f.image('v4.png',4)}).task.versions.length,4);
});

test('图片被覆盖或是伪图片时拒绝归档，失败不增加进度',t=>{
  const f=setup(t);f.change({action:'start',brief:'鱼'});
  fs.mkdirSync(path.join(f.root,'images'));fs.writeFileSync(path.join(f.root,'images/fake.png'),'not an image');
  assert.throws(()=>f.change({action:'attach',evidencePath:'images/fake.png'}),/图片/);
  f.change({action:'attach',evidencePath:f.image('ok.png')});f.change({action:'review',verdict:'accept',note:'检查主体与构图',checks:[{id:'c1',passed:true,note:'实际检查主体构图和要求'}]});
  fs.appendFileSync(path.join(f.root,'images/ok.png'),'changed');
  assert.throws(()=>f.change({action:'archive'}),/图片已变化/);
  assert.equal(readJson(f.file).items[0].done,8);
});

test('归档与交付分开；需要匹配作品哈希，跨会话不能改流程',t=>{
  const f=setup(t);f.change({action:'start',brief:'鱼'});f.change({action:'attach',evidencePath:f.image('v1.png')});
  f.change({action:'review',verdict:'accept',note:'主体和画面完整',checks:[{id:'c1',passed:true,note:'实际检查主体构图和要求'}]});const archived=f.change({action:'archive'});
  assert.equal(archived.task.delivery,undefined);
  f.context.messages.push({messageId:'wrong',isSelf:true,time:f.context.now+1,artifactHashes:['bad']});
  assert.throws(()=>f.change({action:'deliver',deliveredMessageId:'wrong'}),/匹配/);
  f.context.messages.push({messageId:'ok',isSelf:true,time:f.context.now+1,artifactHashes:[archived.task.versions[0].artifact.sha256]});
  assert.equal(f.change({action:'deliver',deliveredMessageId:'ok'}).task.delivery.messageId,'ok');
  assert.throws(()=>changeProject(f.file,'group:2',{action:'start',brief:'篡改'},f.context),/其他会话/);
  assert.equal(projectView(f.file,'group:2')[0].workflow,null);
});

test('页面推进优先于随机闲聊，但半小时内不反复唤醒',()=>{
  const now=Date.parse('2026-10-26T12:00:00+08:00');
  const status={mode:'reserved2',dshReady:true,snowluma:{connected:true}},state={ok:true,lastIncomingAt:now-600000,lastAiReplyAt:now-600000,unreadCount:0};
  const work={id:'page1',stage:'generate'};
  assert.equal(proactiveDecision({status,state,now,random:1,work}).reason,'project');
  assert.equal(proactiveDecision({status,state,now,random:0,work,counter:{lastProjectId:'page1',lastProjectWakeAt:now-1000}}).ok,false);
});

test('操作台授权有独立来源，模型输入不能冒充用户确认',t=>{
 const f=setup(t);f.change({action:'start',brief:'书桌'});
 for(let i=0;i<3;i++){f.change({action:'block',note:'连接失败'});if(i<2){f.context.now+=1800001;f.change({action:'resume'});}}
 assert.throws(()=>f.change({action:'resume',operatorReason:'模型自行决定'}),/用户/);
 f.context.operatorConfirmation={reason:'用户在操作台要求换方法继续'};
 const resumed=f.change({action:'resume'});
 assert.equal(resumed.task.stage,'generate');
 assert.equal(resumed.task.operatorConfirmations[0].source,'authenticated_operator');
 assert.equal(resumed.task.history.filter(h=>h.action==='block').length,3);
});
