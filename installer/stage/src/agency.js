import crypto from 'node:crypto';
import {readJson,updateJson} from './state-store.js';
import {verifyArtifact} from './commitments.js';

const HOUR=3600000,DAY=24*HOUR;
const empty=()=>({version:1,focus:{},decisions:[],attempts:[]});
const uid=()=>crypto.randomUUID();
const day=now=>new Date(now+8*HOUR).toISOString().slice(0,10);
const short=value=>String(value||'').trim().slice(0,600);
function validArtifact(artifact,context){
 if(!artifact?.path||!artifact.sha256||!context.root)return false;
 try{return verifyArtifact(context.root,artifact.path).sha256===artifact.sha256;}catch{return false;}
}
// These are references to existing workflows, not a second task list. All progress is re-derived.
export function agencyCandidates(context){
 const result=[],now=context.now??Date.now();
 for(const p of context.continuity?.practices||[]){
  const reviews=(p.reviews||[]).filter(r=>validArtifact(r.artifact,context));
  const next=p.steps.find(s=>s.status==='pending');
  result.push({id:'practice:'+p.id,entityId:p.id,kind:'practice',title:p.title,motive:p.motive,origin:p.origin,
   status:p.status,createdAt:p.createdAt,availableAt:p.nextWakeAt||0,blocked:p.status==='paused',
   evidence:reviews.map(r=>({id:r.id,at:r.at,passed:r.passed,sha256:r.artifact.sha256,kind:r.kind})),
   next:next?{id:p.id,stepId:next.id,title:p.title,action:next.text,criterion:next.criterion}:null});
 }
 for(const p of context.projects||[])for(const task of p.workflow?.tasks||[]){
  const evidence=(task.versions||[]).filter(v=>v.review&&validArtifact(v.artifact,context)).map(v=>({
   id:task.id+':v'+v.number,at:v.review.at||v.attachedAt,passed:v.review.verdict==='accept',sha256:v.artifact.sha256,kind:'agent_self_assessment'}));
  result.push({id:'project:'+task.id,entityId:task.id,kind:'project',projectId:p.id,title:task.brief,motive:task.brief,origin:task.origin||'legacy_unknown',
   status:task.stage==='archived'?'completed':task.stage,createdAt:task.createdAt,availableAt:task.retryAt||0,
   blocked:task.stage==='blocked'&&(task.needsHelp||!task.retryAt||task.retryAt>now),evidence,
   next:{id:task.id,projectId:p.id,stage:task.stage,nextAction:task.stage==='blocked'?'resume':task.stage,brief:task.brief}});
 }
 return result;
}
function active(candidate){return candidate&&!['completed','abandoned'].includes(candidate.status);}
function request(context,id,pattern){
 const m=context.messages?.find(m=>String(m.messageId)===String(id)&&m.isOwner&&!m.isSelf&&(!m.userId||String(m.userId)===String(context.ownerQQ)));
 const quote=String(m?.plain||m?.text||'');const at=Number(m?.time||m?.at);
 if(!m||!quote||quote.length>1200||!Number.isFinite(at)||at<=0||at>(context.now??Date.now())+2000||/假如|假设|开玩笑|没说|没有说|转述|朋友说/.test(quote)||!pattern.test(quote))throw new Error('需要真实用户明确的新决定，模型理由或群友消息不能冒充');
 return {messageId:String(m.messageId),quote,at};
}
function progress(candidate){return (candidate?.evidence||[]).filter(e=>e.passed).map(e=>e.id+':'+e.sha256);}
function novel(focus,candidate){return progress(candidate).filter(e=>!focus.baselineEvidence.includes(e));}
function attemptsFor(store,key,focus,candidate){
 const ids=progress(candidate).join('|');
 return store.attempts.filter(a=>a.key===key&&a.focusId===focus.id&&a.candidateId===candidate.id&&a.progressFingerprint===ids&&['reserved','accepted','queued','uncertain'].includes(a.status));
}
function chooseCandidate(candidates){
 return candidates.filter(c=>active(c)&&!c.blocked).sort((a,b)=>{
  // Self-selected practice gets a protected place alongside the album; current focus stays sticky.
  const score=c=>(c.origin==='owner_request'?30:c.origin==='self_selected'?20:0)+Math.min(5,progress(c).length);
  return score(b)-score(a)||a.createdAt-b.createdAt||a.id.localeCompare(b.id);
 })[0]||null;
}
function projection(store,key,context){
 const now=context.now??Date.now(),candidates=agencyCandidates(context),saved=store.focus[key];
 const current=candidates.find(c=>c.id===saved?.candidateId);
 // A temporarily blocked focus is retained, with other work as a temporary fallback.
 const selected=active(current)?current:chooseCandidate(candidates);
 const focus=active(current)?saved:selected?{id:null,candidateId:selected.id,selectedAt:now,baselineEvidence:progress(selected),origin:'not_selected_yet'}:null;
 const requested=candidates.filter(c=>active(c)&&!c.blocked&&c.origin==='owner_request'&&c.id!==selected?.id&&c.createdAt>=focus?.selectedAt).sort((a,b)=>a.createdAt-b.createdAt)[0];
 const fallback=requested||(selected?.blocked?chooseCandidate(candidates.filter(c=>c.id!==selected.id)):null);
 const working=fallback||selected;
 const budget=store.attempts.filter(a=>a.key===key&&day(a.at)===day(now)&&['reserved','accepted','queued','uncertain'].includes(a.status));
 const last=budget.at(-1);
 let hold=null;
 if(selected?.blocked&&!fallback)hold='主目标受阻，保留方向，等待实际条件或明确新决定';
 else if(working?.availableAt>now)hold='尚在已有练习或项目的休息/重试时间内';
 else if(focus?.id&&attemptsFor(store,key,focus,working).length>=3)hold='同一证据状态下已尝试三次，没有新成果；暂停自动唤醒，先调整方法';
 else if(budget.length>=3)hold='今天自主工作预算已用完，跨天再继续，不靠连续唤醒堆进度';
 else if(last&&now-last.at<30*60000)hold='独立工作之间至少休息30分钟';
 const next=working&&active(working)&&!working.blocked&&!hold?{...working.next,kind:working.kind,candidateId:working.id,temporary:Boolean(fallback)}:null;
 const executing=store.attempts.filter(a=>a.key===key&&a.focusId===focus?.id&&['reserved','accepted','queued'].includes(a.status)&&now-a.at>=0&&now-a.at<30*60000&&context.autonomous&&context.wakeReason===a.kind).at(-1);
 const executionCandidate=candidates.find(c=>c.id===executing?.candidateId);
 const activeWork=executionCandidate?{...executionCandidate.next,kind:executionCandidate.kind,candidateId:executionCandidate.id,ticketId:executing.id}:null;
 return {enabled:true,focus,candidates,next,activeWork,hold,hasGoals:candidates.some(active),
  persistence:{newVerifiedMilestones:focus?novel(focus,current).length:0,daysWithEvidence:[...new Set((current?.evidence||[]).filter(e=>e.passed).map(e=>day(e.at)))].length,
   meaning:'作品检查证据，不等于用户认可、主观意愿或能力证明'},
  budget:{used:budget.length,limit:3,day:day(now)},
  decisions:store.decisions.filter(d=>d.key===key).slice(-15),attempts:store.attempts.filter(a=>a.key===key).slice(-15)};
}
export function agencyView(file,key,context){return projection(readJson(file,empty()),key,context);}
function setFocus(store,key,candidate,context,reason,source=null){
 const now=context.now??Date.now(),old=store.focus[key];
 const focus={id:uid(),candidateId:candidate.id,selectedAt:now,baselineEvidence:progress(candidate),origin:'existing_plan_selection'};
 store.focus[key]=focus;
 store.decisions.push({id:uid(),key,at:now,action:'choose',from:old?.candidateId||null,to:candidate.id,reason:short(reason),source,
  evidenceIds:candidate.evidence.map(e=>e.id),alternatives:agencyCandidates(context).filter(c=>active(c)&&c.id!==candidate.id).map(c=>({id:c.id,status:c.status})),
  opportunityCost:'其他未取消计划暂缓；约定和用户新请求仍优先',meaning:'可追溯的程序取舍，不证明主观欲望'});
 return focus;
}
export function changeAgency(file,key,input,context){
 let result;updateJson(file,empty(),store=>{
  const view=projection(store,key,context),now=context.now??Date.now();
  if(!short(input.reason))throw new Error('取舍需要具体理由');
  const target=view.candidates.find(c=>c.id===input.candidateId);
  if(!active(target)||target.blocked)throw new Error('目标必须引用现有可继续的练习或页面，不能虚构或绕过受阻状态');
  const current=view.candidates.find(c=>c.id===store.focus[key]?.candidateId),focus=store.focus[key];
  let source=null;
  if(input.sourceMessageId){
   source=request(context,input.sourceMessageId,/先|优先|改|换|继续|恢复|调整|暂停|取消/);
   if(focus&&source.at<focus.selectedAt)throw new Error('旧消息不能冒充当前取舍的新决定');
   // Naming the target prevents borrowing an unrelated user instruction as permission to switch.
   const words=[target.title,target.entityId].filter(Boolean);
   const targeted=source.quote.split(/[，,。；;\n]/).some(clause=>words.some(w=>clause.includes(w))&&/先|优先|改|换|继续|恢复|调整/.test(clause)&&!/别|不要|不用|不想|先不/.test(clause));
   if(!targeted)throw new Error('新决定必须明确指向这个已有目标的标题或编号');
  }
  if(focus&&current?.id===target.id){
   if(!source)throw new Error('当前方向已经选定，不能无证据刷新起点或清除停滞记录');
  }else if(focus&&active(current)&&!current.blocked&&!source){
   const fresh=novel(focus,current);
   if(fresh.length<2||(now-focus.selectedAt<7*DAY&&fresh.length<3))throw new Error('先坚持当前方向：切换需要新作品证据和阶段复盘，不能每轮重选');
  }
  result=setFocus(store,key,target,context,input.reason,source);return store;
 });return result;
}
export function assertAgencyMutation(file,key,input,context){
 const store=readJson(file,empty()),focus=store.focus[key];
 const advances=['practice_attach','practice_review','practice_resume','attach','review','archive','resume','block'];
 if(context.autonomous&&advances.includes(input.action)) {
  const now=context.now??Date.now();
  const ticket=store.attempts.filter(a=>a.key===key&&['reserved','accepted','queued'].includes(a.status)&&now-a.at>=0&&now-a.at<30*60000).at(-1);
  const candidate=agencyCandidates(context).find(c=>c.id===ticket?.candidateId);
  const project=context.projects?.find(p=>p.id===(input.projectId||context.activeProjectId));
  const inputId=input.id||input.taskId||(candidate?.kind==='project'?project?.workflow?.activeId:null);
  if(!ticket||!candidate||ticket.focusId!==focus?.id||context.wakeReason!==ticket.kind||(inputId&&inputId!==candidate.entityId)||(candidate.kind==='project'&&input.projectId&&input.projectId!==candidate.projectId)||candidate.kind!==(input.action.startsWith('practice_')?'practice':'project'))throw new Error('[AGENCY_HOLD] 自主推进必须使用已预留的当前目标机会，不能换工具推进其他目标');
  if(!['archive','block'].includes(input.action)&&progress(candidate).join('|')!==ticket.progressFingerprint)throw new Error('[AGENCY_HOLD] 这一轮已有新的检查成果，先收尾休息，不连做下一步');
 }
 if(!['practice_start','practice_pause','practice_abandon','start'].includes(input.action))return;
 if(!focus)return;
 const current=agencyCandidates(context).find(c=>c.id===focus.candidateId);if(!active(current)||current.blocked)return;
 if(input.action==='start'&&current.kind==='project'&&(input.projectId||context.activeProjectId)===current.projectId&&context.projects?.find(p=>p.id===current.projectId)?.workflow?.activeId===current.entityId)return;
 if(input.sourceMessageId){
  const source=request(context,input.sourceMessageId,/先|优先|暂停|取消|不做|放弃|帮我|给我|请|练|画|写/);
  if(source.at<focus.selectedAt)throw new Error('旧要求不能覆盖新主目标');
  if(input.action==='practice_abandon'&&!/取消|不做|放弃/.test(source.quote))throw new Error('放弃当前方向需要用户明确取消，其他新要求只是临时让路');
  if(input.action==='practice_pause'&&!/暂停|休息|先不/.test(source.quote))throw new Error('暂停需要实际新失败或明确的暂停要求');
  return;
 }
 if(input.action==='practice_pause'&&current.kind==='practice'&&input.id===current.entityId){
  if(current.evidence.some(e=>!e.passed&&e.at>=focus.selectedAt))return;
 }
 if(['practice_pause','practice_abandon'].includes(input.action)&&input.id!==current.entityId)return;
 throw new Error('[AGENCY_HOLD] 当前主目标尚未完成；先推进或用qq_agency依据新证据复盘，不用新待办逃避原方向');
}
export function reserveAgencyWake(file,key,context,reason){
 let ticket;updateJson(file,empty(),store=>{
  let view=projection(store,key,context);
  if(!view.next||view.next.kind!==reason)throw new Error('[AGENCY_HOLD] '+(view.hold||'当前应推进'+(view.next?.kind||'已有目标')));
  const current=view.candidates.find(c=>c.id===store.focus[key]?.candidateId);
  if(!active(current))setFocus(store,key,view.candidates.find(c=>c.id===view.next.candidateId),context,'首次选择或原目标已收尾，复用已有计划');
  view=projection(store,key,context);
  const working=view.candidates.find(c=>c.id===view.next.candidateId);
  ticket={id:uid(),key,at:context.now??Date.now(),focusId:store.focus[key].id,candidateId:working.id,kind:reason,status:'reserved',
   progressFingerprint:progress(working).join('|'),temporary:view.next.temporary,preemptionReason:view.next.temporary?(working.origin==='owner_request'?'用户新请求临时优先':'主目标暂时受阻，使用已有备选'):null,meaning:'预留一次工作机会；接受唤醒也不代表取得进展'};
  store.attempts.push(ticket);return store;
 });return ticket;
}
export function finishAgencyWake(file,ticketId,status){
 if(!['accepted','queued','failed','uncertain'].includes(status))throw new Error('未知投递结果');
 updateJson(file,empty(),store=>{const a=store.attempts.find(a=>a.id===ticketId);if(!a)throw new Error('工作机会不存在');if(a.status==='reserved')a.status=status;return store;});
}
export function agencyHint(file,key,context){
 const v=agencyView(file,key,context);
 return '\n【自己的判断与目标取舍】'+JSON.stringify({focus:v.focus,currentWork:v.activeWork,next:v.next,holdForNextWake:v.hold,persistence:v.persistence,budget:v.budget})
  +'。qq_agency只引用已有计划；主目标跨天保留，约定或用户新要求可以临时让路，不自动取消原目标。切换需新证据，停滞先暂停而非加新待办。投递次数不算成长。没有证据时承认不知道，不为迎合而改写事实或自我评价。\n';
}
