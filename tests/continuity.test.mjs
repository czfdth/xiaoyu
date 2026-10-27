import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { changeContinuity, continuityView, recordContinuityApplication, observeOwnerCorrection,
  nextPracticeWork, continuityHint, assertContactPolicy, creativeConstraints } from '../src/continuity.js';
import { changeProject, projectView } from '../src/project-workflow.js';
import { proactiveDecision } from '../src/autonomy.js';
import { readJson, writeJson } from '../src/state-store.js';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=','base64');
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-continuity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'state/continuity.json'),key='private:1',context={root,ownerQQ:1,now:Date.now(),messages:[],tasks:[]};
 let seq=0;const say=(quote,more={})=>{const m={messageId:String(++seq),isOwner:true,isSelf:false,userId:'1',text:quote,time:context.now,...more};context.messages.push(m);return m.messageId;};
 const change=input=>changeContinuity(file,key,input,context);
 const image=(name,version=0)=>{const p=path.join(root,'images',name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.concat([PNG,Buffer.from([version])]));return 'images/'+name;};
 return {root,file,key,context,say,change,image,view:task=>continuityView(file,key,context.now,task)};
}
const practice=f=>f.change({action:'practice_start',title:'练习构图',motive:'想让主体清楚一些',skill:'drawing',steps:[{text:'画一幅鲸鱼',criterion:'主体完整且居中'}]});

test('空读取不创建人格或改旧记忆，反馈保存在独立文件',t=>{
 const f=setup(t);assert.equal(f.view().feedback.length,0);assert.equal(fs.existsSync(f.file),false);assert.match(continuityHint(f.file,f.key),/尚未建立/);
});
test('用户纠正有原话和范围；临时评价、玩笑、群友和自己说的话不能永久化',t=>{
 const f=setup(t);const sourceMessageId=f.say('这次聊天语气太硬');
 assert.throws(()=>f.change({action:'feedback',sourceMessageId,dimension:'tone',scope:'conversation'}),/临时/);
 const one=f.change({action:'feedback',sourceMessageId,dimension:'tone',scope:'session'});assert.equal(one.source.quote,'这次聊天语气太硬');
 assert.throws(()=>f.change({action:'feedback',sourceMessageId:f.say('这张画我不喜欢'),dimension:'art_style',scope:'session'}),/单件作品/);
 for(const [quote,more] of [['以后开玩笑说你都用油画',{}],['以后都用水彩',{isOwner:false,userId:'2'}],['以后我喜欢油画',{isSelf:true}]]){
  const id=f.say(quote,more);assert.throws(()=>f.change({action:'feedback',sourceMessageId:id,dimension:'art_style',scope:'conversation'}));
 }
 for(const quote of ['朋友说以后都用油画','我没说以后不要模板','以后用水彩'+ '字'.repeat(1300)+'开玩笑']) {
  const id=f.say(quote);assert.throws(()=>f.change({action:'feedback',sourceMessageId:id,dimension:'art_style',scope:'conversation'}));
 }
 assert.equal(f.view().feedback.length,1);
});
test('同一原话去重，不同的兼容要求不互相覆盖；替代与撤回保留历史',t=>{
 const f=setup(t),a=f.say('以后不要改变蓝色发色'),b=f.say('以后尾巴要保留');
 const first=f.change({action:'feedback',sourceMessageId:a,dimension:'character',scope:'conversation'});
 f.change({action:'feedback',sourceMessageId:a,dimension:'character',scope:'conversation'});
 f.change({action:'feedback',sourceMessageId:b,dimension:'character',scope:'conversation'});assert.equal(f.view().activeFeedback.length,2);
 const c=f.say('以后改成深蓝色发色');f.change({action:'feedback',sourceMessageId:c,dimension:'character',scope:'conversation',replacesId:first.id});
 assert.equal(f.view().feedback[0].status,'superseded');assert.equal(f.view().activeFeedback.length,2);
 const retract=f.say('撤回刚才尾巴那条要求');const tail=f.view().feedback.find(x=>x.source.messageId===b);
 f.change({action:'retract_feedback',id:tail.id,sourceMessageId:retract});assert.equal(f.view().activeFeedback.length,1);
 assert.equal(f.view().feedback.length,3);
});
test('任务评价不挪用到其他页面；临时反馈按原话发生时间过期',t=>{
 const f=setup(t);f.context.tasks=[{id:'p1',createdAt:f.context.now-1000},{id:'p2',createdAt:f.context.now+1000}];
 const sourceMessageId=f.say('这张尾巴太小');f.change({action:'feedback',sourceMessageId,dimension:'character',scope:'task',taskId:'p1'});
 assert.equal(f.view('p1').activeFeedback.length,1);assert.equal(f.view('p2').activeFeedback.length,0);
 assert.throws(()=>f.change({action:'feedback',sourceMessageId:f.say('这张耳朵不对'),dimension:'character',scope:'task',taskId:'p2'}),/开始前/);
 const old=f.say('刚才说话太长',{time:f.context.now-13*3600000});f.change({action:'feedback',sourceMessageId:old,dimension:'tone',scope:'session'});
 assert.equal(f.view().activeFeedback.length,0);
});
test('安静要求按原话时间执行；不能从没回复推断需要安静',t=>{
 const f=setup(t);assert.equal(f.view().policy.proactiveDisabled,false);
 const msg=f.say('先别找我，30分钟让我静静');f.change({action:'feedback',sourceMessageId:msg,dimension:'contact',scope:'session'});
 assert.equal(f.view().policy.proactiveDisabled,true);f.context.now+=1800001;assert.equal(f.view().policy.proactiveDisabled,false);
});
test('少连发、纠正称呼与简短要求实际阻止不符合要求的发送',t=>{
 const f=setup(t);
 for(const [quote,dimension] of [['以后别连发，一条就好','contact'],['以后别叫我爸爸','address'],['以后说话简短一点','tone']]) f.change({action:'feedback',sourceMessageId:f.say(quote),dimension,scope:'conversation'});
 assert.throws(()=>assertContactPolicy(f.view(),{messages:['爸爸，你好']}),/称呼/);
 assert.throws(()=>assertContactPolicy(f.view(),{messages:['长'.repeat(121)]}),/120/);
 assertContactPolicy(f.view(),{intent:'turn1',messages:['你好']});
 recordContinuityApplication(f.file,f.key,{operation:'send',feedbackIds:f.view().activeFeedback.map(x=>x.id),evidenceId:'real-receipt',intent:'turn1'},f.context.now);
 assert.throws(()=>assertContactPolicy(f.view(),{intent:'turn1',messages:['再补一句'],now:f.context.now+1}),/停止追加/);
 assertContactPolicy(f.view(),{intent:'new-turn',messages:['你好']});
});
test('要求安静仍能回应新的主动来信，不能通过其他工具绕过主动静默',t=>{
 const f=setup(t);f.change({action:'feedback',sourceMessageId:f.say('以后不要主动打扰我'),dimension:'contact',scope:'conversation'});
 assert.throws(()=>assertContactPolicy(f.view(),{state:{lastWakeReason:'life',lastIncomingAt:f.context.now},now:f.context.now}),/暂不主动/);
 assertContactPolicy(f.view(),{state:{lastWakeReason:'private',lastIncomingAt:f.context.now},now:f.context.now});
});
test('实际创作请求带入画面纠正；明确不要模板时关闭模板路线',t=>{
 const f=setup(t);f.change({action:'feedback',sourceMessageId:f.say('以后不要模板插画'),dimension:'art_style',scope:'conversation'});
 f.change({action:'feedback',sourceMessageId:f.say('以后尾巴保留'),dimension:'character',scope:'conversation'});
 const request=creativeConstraints(f.view(),'在海边');assert.equal(request.avoidLocalTemplates,true);assert.match(request.prompt,/尾巴保留/);assert.equal(request.feedbackIds.length,2);
});
test('误会修复必须经过实际行为证据，再由后来的用户原话确认',t=>{
 const f=setup(t);const feedback=f.change({action:'feedback',sourceMessageId:f.say('你理解错了，以后语气简短一点'),dimension:'tone',scope:'conversation'});
 const repair=f.view().repairs[0];assert.equal(repair.status,'open');
 const premature=f.say('对了');assert.throws(()=>f.change({action:'confirm_repair',id:repair.id,sourceMessageId:premature}),/尚没有/);
 f.context.now+=1;recordContinuityApplication(f.file,f.key,{operation:'send',feedbackIds:[feedback.id],evidenceId:'actual-message'},f.context.now);assert.equal(f.view().repairs[0].status,'applied');
 assert.throws(()=>f.change({action:'confirm_repair',id:repair.id,sourceMessageId:premature}),/之后|认可/);
 f.context.now+=1;assert.throws(()=>f.change({action:'confirm_repair',id:repair.id,sourceMessageId:f.say('对了，明天聊别的事情')}),/明确认可/);
 f.context.now+=1;f.change({action:'confirm_repair',id:repair.id,sourceMessageId:f.say('这样就好，你理解对了')});assert.equal(f.view().repairs[0].status,'confirmed');
});
test('自动识别只接收明确的用户纠正，不把问题、玩笑或沉默变成偏好',t=>{
 const f=setup(t);
 for(const quote of ['以后别用简笔画？','假如以后你用油画','你好','这张尾巴太小']){
  const messageId=f.say(quote);assert.equal(observeOwnerCorrection(f.file,f.key,f.context.messages.at(-1),f.context),null);
 }
 f.say('以后别用简笔画');assert(observeOwnerCorrection(f.file,f.key,f.context.messages.at(-1),f.context));assert.equal(f.view().policy.avoidLocalTemplates,true);
});
test('兴趣计划有动机与小步骤，不冒称用户要求，也不允许并行堆无界目标',t=>{
 const f=setup(t);const p=practice(f);assert.equal(p.origin,'self_selected');assert.equal(nextPracticeWork(f.view(),f.context.now).stepId,'step-1');
 assert.throws(()=>practice(f),/已有/);
 assert.throws(()=>f.change({action:'practice_start',title:'练习',motive:'想学',skill:'drawing',steps:[]}),/1到5/);
});
test('练习先给作品预览再自检；同一件作品不重复计分，已完成可重读接续',t=>{
 const f=setup(t);const p=practice(f);
 assert.throws(()=>f.change({action:'practice_review',id:p.id,stepId:'step-1',passed:true,note:'主体完整'}),/预览/);
 const image=f.image('one.png');f.change({action:'practice_attach',id:p.id,stepId:'step-1',evidencePath:image});
 const checked=f.change({action:'practice_review',id:p.id,stepId:'step-1',passed:true,note:'主体完整，画面边缘没有截断'});
 assert.equal(checked.status,'completed');assert.equal(checked.reviews[0].kind,'agent_self_assessment');assert.equal(nextPracticeWork(f.view(),f.context.now),null);
 const preview=f.change({action:'practice_preview',id:p.id,reviewId:checked.reviews[0].id});assert.equal(preview.previewArtifact.sha256,checked.reviews[0].artifact.sha256);
 assert.match(f.view().capability.limitation,/自评/);
});
test('旧作品、伪图片、作品被覆盖均不能当作这次练习完成',t=>{
 const f=setup(t);const image=f.image('old.png');fs.utimesSync(path.join(f.root,image),new Date(1),new Date(1));const p=practice(f);
 assert.throws(()=>f.change({action:'practice_attach',id:p.id,stepId:'step-1',evidencePath:image}),/旧作品/);
 fs.writeFileSync(path.join(f.root,'images/fake.png'),'no image');assert.throws(()=>f.change({action:'practice_attach',id:p.id,stepId:'step-1',evidencePath:'images/fake.png'}),/实际图片/);
 const fresh=f.image('new.png');f.change({action:'practice_attach',id:p.id,stepId:'step-1',evidencePath:fresh});fs.appendFileSync(path.join(f.root,fresh),'changed');
 assert.throws(()=>f.change({action:'practice_review',id:p.id,stepId:'step-1',passed:true,note:'检查构图'}),/变化/);
 assert.equal(f.view().practices[0].steps[0].status,'pending');
});
test('三次实际未达标后暂停，保留作品与原因，不循环刷练习',t=>{
 const f=setup(t),p=practice(f);
 for(let i=0;i<3;i++){f.change({action:'practice_attach',id:p.id,stepId:'step-1',evidencePath:f.image(i+'.png',i)});f.change({action:'practice_review',id:p.id,stepId:'step-1',passed:false,note:'主体仍被画面边缘截断'});}
 assert.equal(f.view().practices[0].status,'paused');assert.equal(f.view().practices[0].reviews.length,3);
 assert.throws(()=>f.change({action:'practice_resume',id:p.id,note:'再试'}),/真实用户/);
});
test('自我认识保留版本及依据；不能没有新经历就每轮改写身份倾向',t=>{
 const f=setup(t),p=practice(f);
 assert.throws(()=>f.change({action:'self_update',field:'strength',value:'我擅长构图',reason:'我觉得',evidenceIds:[p.id]}),/作品检查/);
 const first=f.change({action:'self_update',field:'interest',value:'想练习构图',reason:'选择了这个小练习',evidenceIds:[p.id]});
 const same=f.change({action:'self_update',field:'interest',value:'想练习构图',reason:'又想说一遍',evidenceIds:[p.id]});assert.equal(first.id,same.id);
 assert.throws(()=>f.change({action:'self_update',field:'interest',value:'其实不喜欢绘画',reason:'随便改一下',evidenceIds:[p.id]}),/新经历/);
 f.change({action:'practice_attach',id:p.id,stepId:'step-1',evidencePath:f.image('practice.png')});f.context.now+=1;
 const checked=f.change({action:'practice_review',id:p.id,stepId:'step-1',passed:true,note:'这次主体完整且居中'});
 const newer=f.change({action:'self_update',field:'interest',value:'开始喜欢练习构图',reason:'完成了第一件有检查的作品',evidenceIds:[checked.reviews[0].id]});
 assert.equal(newer.previousId,first.id);assert.equal(f.view().selfStatements.length,2);assert.equal(newer.kind,'evidence_linked_self_report');
});
test('连续性状态按会话隔离，群友不能写自己的偏好，不能读取其他会话的成长',t=>{
 const f=setup(t);practice(f);f.change({action:'feedback',sourceMessageId:f.say('以后语气简短'),dimension:'tone',scope:'conversation'});
 const other=continuityView(f.file,'group:2',f.context.now);assert.equal(other.feedback.length,0);assert.equal(other.practices.length,0);
 assert.throws(()=>changeContinuity(f.file,'group:2',{action:'feedback',sourceMessageId:f.context.messages[0].messageId,dimension:'tone',scope:'conversation'},{...f.context,messages:f.context.messages.map(m=>({...m,key:f.key}))}),/真实用户/);
});
test('任务归档需逐项验收，新用户要求到来后不能沿用旧检查',t=>{
 const f=setup(t),file=path.join(f.root,'state/projects.json');writeJson(file,{active:'album',items:[{id:'album',kind:'drawing',done:8,total:20}]});
 const context={root:f.root,now:f.context.now,messages:[],feedback:[]};
 const start=changeProject(file,f.key,{action:'start',brief:'鲸鱼',criteria:['蓝发','鲸鱼尾巴']},context);
 changeProject(file,f.key,{action:'attach',evidencePath:f.image('page.png')},context);
 assert.throws(()=>changeProject(file,f.key,{action:'review',verdict:'accept',note:'很好'},context),/每项验收/);
 changeProject(file,f.key,{action:'review',verdict:'accept',note:'对照两项检查',checks:[{id:'c1',passed:true,note:'画面头发确实蓝色'},{id:'c2',passed:true,note:'尾巴完整且能看清'}]},context);
 context.feedback=[{id:'new',status:'active',dimension:'character',scope:'conversation',source:{quote:'尾巴再放大'}}];
 assert.throws(()=>changeProject(file,f.key,{action:'archive'},context),/新要求/);
 assert.equal(projectView(file,f.key,context.feedback)[0].workflow.tasks[0].criteria.length,3);
 assert.equal(readJson(file).items[0].done,8);assert.equal(start.task.pageNumber,9);
});
test('用户要求安静时不主动聊天，但可独立推进兴趣练习；不靠未回复推断心情',()=>{
 const now=Date.parse('2026-10-26T12:00:00+08:00'),status={mode:'reserved2',dshReady:true,snowluma:{connected:true}},state={ok:true,lastIncomingAt:now-600000,lastAiReplyAt:now-600000,unreadCount:0,relationship:{proactiveDisabled:true}};
 assert.equal(proactiveDecision({status,state,now,random:0}).ok,false);
 assert.equal(proactiveDecision({status,state,now,practice:{id:'practice1'}}).reason,'practice');
 assert.equal(proactiveDecision({status,state,now,practice:{id:'practice1'},counter:{lastPracticeId:'practice1',lastPracticeWakeAt:now-100}}).ok,false);
});
