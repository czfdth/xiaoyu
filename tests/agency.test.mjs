import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {agencyView,changeAgency,reserveAgencyWake,finishAgencyWake,assertAgencyMutation} from '../src/agency.js';
import {writeJson,readJson} from '../src/state-store.js';
import {verifyArtifact} from '../src/commitments.js';
import {proactiveDecision} from '../src/autonomy.js';
const DAY=86400000;
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-agency-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'state/agency.json'),key='private:1';fs.mkdirSync(path.join(root,'images'),{recursive:true});
 const now=Date.parse('2026-10-27T04:00:00Z');
 const practice=id=>({id,title:'练习'+id,motive:'想学会构图',skill:'drawing',origin:'self_selected',createdAt:now-1000,status:'active',steps:[{id:'s1',text:'画鲸鱼',criterion:'主体完整',status:'pending'}],reviews:[]});
 const context={root,ownerQQ:'1',now,messages:[],continuity:{practices:[practice('a'),practice('b')]},projects:[]};
 const view=()=>agencyView(file,key,context),choose=(id,extra={})=>changeAgency(file,key,{candidateId:'practice:'+id,reason:'持续练习构图',...extra},context);
 const evidence=(id,passed=true)=>{const p=context.continuity.practices.find(p=>p.id===id),name='images/'+id+'-'+p.reviews.length+'.png';fs.writeFileSync(path.join(root,name),Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=','base64'),Buffer.from(id+'-'+p.reviews.length)]));const artifact=verifyArtifact(root,name);p.reviews.push({id:'review-'+id+'-'+p.reviews.length,at:context.now,passed,artifact,kind:'agent_self_assessment'});return artifact;};
 const incoming=(quote,extra={})=>{const m={messageId:String(context.messages.length+1),plain:quote,time:context.now,isOwner:true,userId:'1',...extra};context.messages.push(m);return m.messageId;};
 return {root,file,key,context,view,choose,evidence,incoming};
}
test('候选来自现有计划；status不创建主目标或改写旧数据',t=>{
 const f=setup(t),original=JSON.stringify(f.context);assert.equal(f.view().candidates.length,2);assert.equal(fs.existsSync(f.file),false);assert.equal(JSON.stringify(f.context),original);
});
test('第一次选择保存取舍和机会成本，重读及跨天仍继续同一目标',t=>{
 const f=setup(t);f.choose('a');assert.equal(f.view().focus.candidateId,'practice:a');f.context.now+=3*DAY;assert.equal(f.view().focus.candidateId,'practice:a');assert.equal(f.view().decisions.at(-1).alternatives[0].id,'practice:b');assert.match(f.view().decisions.at(-1).opportunityCost,/暂缓/);
});
test('缺少新经历不能每轮换方向，也不能重复选择清零',t=>{
 const f=setup(t);f.choose('a');assert.throws(()=>f.choose('b'),/先坚持/);assert.throws(()=>f.choose('a'),/不能无证据/);f.context.now+=8*DAY;assert.throws(()=>f.choose('b'),/先坚持/);
});
test('阶段复盘需要新作品证据；旧依据不能重复使用',t=>{
 const f=setup(t);f.evidence('a');f.choose('a');f.context.now+=8*DAY;f.evidence('a');assert.throws(()=>f.choose('b'),/先坚持/);f.evidence('a');f.choose('b');assert.equal(f.view().focus.candidateId,'practice:b');
});
test('三件新成果允许提前阶段调整，伪造或变化的文件不算证据',t=>{
 const f=setup(t);f.choose('a');for(let i=0;i<3;i++)f.evidence('a');
 const artifact=f.context.continuity.practices[0].reviews[0].artifact;fs.writeFileSync(path.join(f.root,artifact.path),'changed');assert.throws(()=>f.choose('b'),/先坚持/);
 f.evidence('a');f.choose('b');assert.equal(f.view().focus.candidateId,'practice:b');
});
test('用户明确改目标可以优先，旧消息、假设和其他人不能借用',t=>{
 const f=setup(t);const old=f.incoming('先做练习b');f.choose('a');f.context.now+=1000;
 const group=f.incoming('先做练习b',{isOwner:false,userId:'2'});assert.throws(()=>f.choose('b',{sourceMessageId:group}),/真实用户/);
 const joke=f.incoming('假如先做练习b');assert.throws(()=>f.choose('b',{sourceMessageId:joke}),/真实用户/);
 const unrelated=f.incoming('先处理另一个事');assert.throws(()=>f.choose('b',{sourceMessageId:unrelated}),/明确指向/);
 const proper=f.incoming('先做练习b');f.choose('b',{sourceMessageId:proper});assert.equal(f.view().focus.candidateId,'practice:b');assert.throws(()=>f.choose('a',{sourceMessageId:old}),/旧消息/);
});
test('受阻时临时让路不取消原目标，条件恢复后回来',t=>{
 const f=setup(t);f.choose('a');f.context.continuity.practices[0].status='paused';assert.equal(f.view().next.candidateId,'practice:b');assert.equal(f.view().next.temporary,true);assert.equal(f.view().focus.candidateId,'practice:a');
 f.context.continuity.practices[0].status='active';assert.equal(f.view().next.candidateId,'practice:a');
});
test('新用户任务临时优先；任务收尾后回到原方向而非永久取消',t=>{
 const f=setup(t);f.choose('a');const requested=f.context.continuity.practices[1];requested.origin='owner_request';requested.createdAt=f.context.now+1;f.context.now+=2;
 assert.equal(f.view().next.candidateId,'practice:b');assert.equal(f.view().next.temporary,true);assert.equal(f.view().focus.candidateId,'practice:a');
 requested.status='completed';assert.equal(f.view().next.candidateId,'practice:a');
});
test('完成目标后自动选已有下一目标，不凭空造计划',t=>{
 const f=setup(t);f.choose('a');f.context.continuity.practices[0].status='completed';const ticket=reserveAgencyWake(f.file,f.key,f.context,'practice');assert.equal(ticket.candidateId,'practice:b');assert.equal(f.context.continuity.practices.length,2);
});
test('自主工作预算原子预留，不同调用不能并发绕过；失败不算已执行',t=>{
 const f=setup(t);const ticket=reserveAgencyWake(f.file,f.key,f.context,'practice');assert.throws(()=>reserveAgencyWake(f.file,f.key,f.context,'practice'),/休息/);finishAgencyWake(f.file,ticket.id,'failed');assert.equal(f.view().budget.used,0);reserveAgencyWake(f.file,f.key,f.context,'practice');assert.equal(f.view().budget.used,1);
});
test('接受唤醒不算进展，三次同状态空转就暂停，跨天不洗掉空转',t=>{
 const f=setup(t);for(let i=0;i<3;i++){const ticket=reserveAgencyWake(f.file,f.key,f.context,'practice');finishAgencyWake(f.file,ticket.id,'accepted');f.context.now+=31*60000;}
 assert.equal(f.view().persistence.newVerifiedMilestones,0);assert.equal(f.view().next,null);assert.match(f.view().hold,/三次/);f.context.now+=DAY;assert.equal(f.view().next,null);
 f.evidence('a');assert.equal(f.view().next.candidateId,'practice:a');assert.equal(f.view().persistence.newVerifiedMilestones,1);
});
test('每天预算跨目标共享，临时改方向也不能连续耗资源',t=>{
 const f=setup(t);for(let i=0;i<3;i++){const ticket=reserveAgencyWake(f.file,f.key,f.context,'practice');finishAgencyWake(f.file,ticket.id,'accepted');f.evidence('a');f.context.now+=31*60000;}
 assert.match(f.view().hold,/预算/);assert.equal(f.view().next,null);f.context.now+=DAY;assert.ok(f.view().next);
});
test('新用户决定可解除空转暂停，但不会清除历史或当日预算',t=>{
 const f=setup(t);f.choose('a');for(let i=0;i<3;i++){const a=reserveAgencyWake(f.file,f.key,f.context,'practice');finishAgencyWake(f.file,a.id,'accepted');f.context.now+=31*60000;}f.context.now+=DAY;
 const id=f.incoming('调整后继续练习a');f.choose('a',{sourceMessageId:id});assert.ok(f.view().next);assert.equal(f.view().attempts.length,3);
});
test('计划操作不能绕过主目标，真实用户新要求仍可安排',t=>{
 const f=setup(t);f.choose('a');assert.throws(()=>assertAgencyMutation(f.file,f.key,{action:'practice_start'},f.context),/AGENCY_HOLD/);assert.throws(()=>assertAgencyMutation(f.file,f.key,{action:'practice_abandon',id:'a'},f.context),/AGENCY_HOLD/);
 f.context.now+=1000;const id=f.incoming('请先写一个新练习');assert.doesNotThrow(()=>assertAgencyMutation(f.file,f.key,{action:'practice_start',sourceMessageId:id},f.context));
});
test('有失败作品可以暂停，不把机器故障臆测为兴趣消失',t=>{
 const f=setup(t);f.choose('a');f.evidence('a',false);assert.doesNotThrow(()=>assertAgencyMutation(f.file,f.key,{action:'practice_pause',id:'a'},f.context));assert.equal(f.view().focus.candidateId,'practice:a');assert.equal(f.view().persistence.newVerifiedMilestones,0);
});
test('真实自主操作需要本轮预留目标，其他唤醒原因和其他计划不能绕过',t=>{
 const f=setup(t);f.context.autonomous=true;f.context.wakeReason='practice';
 assert.throws(()=>assertAgencyMutation(f.file,f.key,{action:'practice_attach',id:'a'},f.context),/AGENCY_HOLD/);
 const ticket=reserveAgencyWake(f.file,f.key,f.context,'practice');finishAgencyWake(f.file,ticket.id,'accepted');
 assert.equal(f.view().activeWork.candidateId,'practice:a');assert.equal(f.view().next,null);
 assert.doesNotThrow(()=>assertAgencyMutation(f.file,f.key,{action:'practice_attach',id:'a'},f.context));
 assert.throws(()=>assertAgencyMutation(f.file,f.key,{action:'practice_attach',id:'b'},f.context),/AGENCY_HOLD/);
 f.context.wakeReason='life';assert.throws(()=>assertAgencyMutation(f.file,f.key,{action:'practice_review',id:'a'},f.context),/AGENCY_HOLD/);
 f.context.wakeReason='practice';f.evidence('a');assert.throws(()=>assertAgencyMutation(f.file,f.key,{action:'practice_attach',id:'a'},f.context),/已有新的检查成果/);
});
test('未知目标、跨会话、损坏账本不被静默重建',t=>{
 const f=setup(t);assert.throws(()=>f.choose('made-up'),/现有/);f.choose('a');assert.equal(agencyView(f.file,'private:2',{...f.context,continuity:{practices:[]}}).candidates.length,0);
 fs.writeFileSync(f.file,'broken');assert.throws(()=>f.view());assert.equal(fs.readFileSync(f.file,'utf8'),'broken');
});
test('实际调度选择主目标而非固定先画册；约定临时优先不改变方向',t=>{
 const f=setup(t);f.choose('a');const status={mode:'reserved2',dshReady:true,snowluma:{connected:true,good:true}},state={ok:true,lastIncomingAt:f.context.now-HOUR,unreadCount:0,agency:f.view()};
 const result=proactiveDecision({status,state,now:f.context.now,work:{id:'album'},practice:{id:'a'}});assert.equal(result.reason,'practice');assert.equal(result.practiceId,'a');
 assert.equal(proactiveDecision({status,state,now:f.context.now,due:[{id:'promise'}]}).reason,'commitment');assert.equal(f.view().focus.candidateId,'practice:a');
});
const HOUR=3600000;
