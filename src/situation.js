import crypto from 'node:crypto';
import { readJson, updateJson } from './state-store.js';
import { autonomousReason } from './continuity.js';

const empty=()=>({version:1,judgments:[],actions:[],calibrations:[]});
const id=()=>crypto.randomUUID();
const hash=text=>crypto.createHash('sha256').update(String(text)).digest('hex');
const MINUTE=60000;
export function latestIncoming(state={}) {
  const msg=(state.recentMessages||[]).filter(m=>!m.isSelf&&m.messageId!=null).at(-1);
  return msg?{messageId:String(msg.messageId),quote:String(msg.situationQuote||msg.plain||msg.text||'').trim().slice(0,4000),at:Number(msg.time||msg.at||state.lastIncomingAt),
    speakerId:msg.userId==null?null:String(msg.userId),isOwner:msg.isOwner===true}:null;
}
function contextualSource(source,now){return source&&Number.isFinite(source.at)&&source.at>0&&now-source.at<=30*MINUTE&&source.at<=now+2000;}
const solve=/(?:给我|帮我|请).{0,15}(?:建议|办法|方案|分析|安排|规划)|怎么办|怎么解决|怎么做|如何解决|推荐一下/;
const task=/(?:帮我|请你|给我|我要|我想要).{0,25}(?:写|画|做|改|查|找|整理|分析|解释|讲|发|说|练)|能不能.{0,20}(?:写|画|做|改|查|找|解释)/;
export function inferSituation(source,now=Date.now()) {
  const quote=contextualSource(source,now)?source.quote:'';
  const usable=Boolean(quote)&&quote.length<=1200&&!/假如|假设|梦见|开玩笑|没有说|没说|并不是|转述|朋友说|^他说|^她说/.test(quote);
  const clauses=quote.split(/[，,。；;\n]/).filter(Boolean);
  let need='unknown',basis='没有足够明确的新线索，不猜测用户心情或需要';
  if(usable) {
    for(const clause of clauses){
      if(/别.*建议|不要.*建议|不用.*建议|不是要.*建议|只想.*(?:说|吐槽|聊)|听我说/.test(clause)){need='listen';basis='原话明确偏向倾听或不需要建议';}
      else if(solve.test(clause)){need='solve';basis='原话明确请求办法或建议';}
      else if(task.test(clause)){need='execute';basis='原话提出具体任务';}
      else if(/先这样|先不聊|不聊了|晚安|去睡了|到这儿|先忙了|不说了|不用了|没别的/.test(clause)&&!/[?？]/.test(clause)){need='closing';basis='原话明确收尾，先结束而不追问';}
      else if(/(?:我|今天|最近|现在|真的|好|很).{0,6}(?:累|烦|难受|心情不好|压力大)|想吐槽|想说说/.test(clause)&&!/[?？]/.test(clause)){need='listen';basis='原话表达疲惫或倾诉线索，暂按简短倾听处理，不当成情绪事实';}
    }
    if(need==='unknown'&&/^(嗯+|哦+|好[的吧]?|知道了|还好|没事)[。！!\s]*$/.test(quote)){need='brief';basis='简短回应，含义不明，不据此推断讨厌或继续追问';}
  }
  const noQuestions=usable&&/别.*(?:问|追问)|不要.*(?:问|追问)|不用.*(?:问|追问)|问过了|又问|刚说过|已经说过/.test(quote);
  const explicitQuestions=usable&&quote.match(/(?:问我|向我提)([一二三四五1-5])(?:个|道)?问题/);
  const count=explicitQuestions?Number(explicitQuestions[1])||'一二三四五'.indexOf(explicitQuestions[1])+1:0;
  const maxQuestions=noQuestions||['listen','closing','brief'].includes(need)?0:count||1;
  return {source,contextValid:usable,need,basis,certainty:'tentative_context_inference',maxQuestions,
    maxBubbles:count?Math.max(2,count):['listen','brief','closing'].includes(need)?1:['solve','execute'].includes(need)?4:2,
    maxChars:need==='listen'?180:need==='brief'?100:need==='closing'?100:null,
    adviceRequested:['solve','execute'].includes(need),limitation:'这是可修正的情境判断，不证明用户的内心状态；沉默不是负面反馈'};
}
export function questionInfo(messages=[]) {
  const result=[];
  for(const raw of messages)for(const part of String(raw).split(/(?<=[?？])\s*|[。！!\n]/)){
    const p=part.trim();if(!p||!(/[?？]/.test(p)||/^(?:要不要|有没有|能不能|是不是|愿不愿意|需不需要)/.test(p)||/(?:吗|呢)[。\s]*$/.test(p)))continue;
    const topic=/心情|还好|难受|累不累|怎么样了|感觉如何/.test(p)?'wellbeing':/在吗|有空|忙不忙|方便/.test(p)?'availability':/进度|做完|完成了|到哪/.test(p)?'progress':/想聊|想说|陪你|要不要聊/.test(p)?'permission_to_chat':/建议|办法|方案/.test(p)?'permission_to_advise':/需要.*帮|要.*帮/.test(p)?'offer_help':hash(p.replace(/请问|一下|你现在|现在|您|你|呢|吗|[?？\s，,]/g,''));
    result.push(topic);
  }
  return {count:result.length,topics:[...new Set(result)]};
}
export function adviceLike(messages=[]) {
  const text=messages.join('\n');
  return /建议你|你应该|你最好|你可以(?:先|尝试|试试|去|做|考虑)|不妨(?:先|试|去)|首先[\s\S]*其次/.test(text)
    || (text.match(/(?:^|\n)\s*(?:[1-9][.、)]|[一二三四五]、)/g)||[]).length>=2;
}
export function situationView(file,key,state={},now=Date.now()) {
  const store=readJson(file,empty()),source=latestIncoming(state),judgment=calibratedJudgment(store,key,source,now);
  return {...judgment,judgments:store.judgments.filter(r=>r.key===key).slice(-12),actions:store.actions.filter(r=>r.key===key).slice(-60),calibrations:store.calibrations.filter(r=>r.key===key).slice(-20)};
}
function calibratedJudgment(store,key,source,now) {
  const judgment=inferSituation(source,now);
  // Continue an explicit task only when this message answers our immediately preceding clarification.
  // A neutral chat turn is never sufficient to invent an ongoing request for advice.
  const prior=store.judgments.filter(j=>j.key===key&&j.source?.messageId!==source?.messageId&&j.source?.at<=source?.at).at(-1);
  const asked=prior&&store.actions.filter(a=>a.key===key&&a.sourceMessageId===prior.source?.messageId&&a.status==='sent').at(-1);
  if(judgment.need==='unknown'&&judgment.contextValid&&prior?.adviceRequested&&asked?.questions.count>0
    &&source.speakerId===prior.source.speakerId&&now-asked.at<10*MINUTE&&!/换.*话题|别说|先不|算了/.test(source.quote)){
    judgment.need=prior.need;judgment.adviceRequested=true;judgment.inheritedRequestMessageId=prior.inheritedRequestMessageId||prior.source.messageId;
    judgment.maxBubbles=4;judgment.basis='当前来信回答紧邻的任务澄清问题，延续之前明确请求；来源:'+judgment.inheritedRequestMessageId;
  }
  const recent=store.calibrations.filter(c=>c.key===key&&c.kind!=='explicit_positive_feedback'&&now-c.source.at>=0&&now-c.source.at<30*MINUTE);
  if(!judgment.adviceRequested&&recent.some(c=>c.kind==='over_advice')){
    judgment.need=judgment.need==='unknown'?'listen':judgment.need;judgment.maxBubbles=1;judgment.maxChars=180;
    judgment.basis+='；近期用户明确纠正过多建议，先保持简短倾听';
  }
  if(!judgment.adviceRequested&&recent.some(c=>c.kind==='repeated_question'))judgment.maxQuestions=0;
  judgment.contactCooldown=recent.some(c=>c.kind==='over_contact');
  judgment.preferenceMismatch=recent.some(c=>c.kind==='preference_mismatch');
  judgment.calibrationIds=recent.map(c=>c.id);return judgment;
}
export function contextualContinuity(view,judgment) {
  const out={...view,policy:{...view.policy,forbiddenNames:[...(view.policy.forbiddenNames||[])]},activeFeedback:[...view.activeFeedback]};
  if(judgment.preferenceMismatch){
    out.activeFeedback=out.activeFeedback.filter(f=>!['tone','detail','art_style'].includes(f.dimension)||f.policy?.avoidLocalTemplates);
    out.policy.maxTextChars=null;
    out.preferenceCalibration='近期明确反对机械套用偏好，暂不自动套用语气、详略或画风；保留联系边界、人物要求和禁止模板';
  }
  const quote=judgment.contextValid&&judgment.source?.isOwner?judgment.source.quote:'',overrides=[];
  // These exceptions only affect presentation and creative preferences, never permissions or permanent stores.
  if(/(?:这次|这回|现在|今天).*(?:详细|展开|多说|长一点)|详细解释|完整步骤|具体步骤/.test(quote)){
    out.policy.maxTextChars=null;out.activeFeedback=out.activeFeedback.filter(f=>!f.policy?.maxTextChars);overrides.push('detail');
  }
  if(/(?:这次|这回).*(?:分几条|分开说|多发几条)/.test(quote)){out.policy.maxBubbles=null;out.activeFeedback=out.activeFeedback.filter(f=>!f.policy?.maxBubbles||f.policy?.proactiveDisabled);overrides.push('bubbles');}
  const templatePermission=/(?:这次|这回).*(?:允许|可以|就用|用).*(?:模板|简笔画|本地插画)/.test(quote)&&!/(?:别|不要|不用).*(?:模板|简笔画|本地插画)/.test(quote);
  const styleChange=/(?:这次|这回).*(?:用|试试|改成).*(?:水彩|油画|像素|漫画|线稿|模板|简笔画)/.test(quote);
  if(styleChange){out.activeFeedback=out.activeFeedback.filter(f=>f.dimension!=='art_style'||(f.policy?.avoidLocalTemplates&&!templatePermission));overrides.push('style');}
  if(templatePermission){out.policy.avoidLocalTemplates=false;overrides.push('template');}
  if(overrides.length)out.situationalOverride={sourceMessageId:judgment.source.messageId,quote,fields:overrides,meaning:'仅本次请求例外，不改写长期偏好'};
  return out;
}
export function wakeSituationDecision(file,key,state,reason,now=Date.now()) {
  if(!['replyCheck','proactiveCheck','ritual','greeting','morning','evening','timeout'].includes(String(reason).split(':')[0]))return {ok:true};
  const view=situationView(file,key,state,now),sourceId=view.source?.messageId||null;
  const active=view.actions.filter(a=>['sent','reserved','uncertain'].includes(a.status)&&now-a.at<6*60*MINUTE);
  if(view.contactCooldown)return {ok:false,reason:'近期明确要求减少主动联系，先等新请求'};
  if(['closing','brief'].includes(view.need))return {ok:false,reason:'当前原话倾向收尾或简短回应，不追加主动话题'};
  if(reason==='replyCheck'&&active.some(a=>a.sourceMessageId===sourceId))return {ok:false,reason:'已经回应，尚无新来信；不因回复检查继续追问'};
  if(active.some(a=>a.autonomous&&a.sourceMessageId===sourceId))return {ok:false,reason:'已主动联系且尚未收到新来信，先等回应，不推断原因'};
  return {ok:true};
}
function judgeSend(store,key,state,messages,voiceUnknown,now) {
  const source=latestIncoming(state),judgment=calibratedJudgment(store,key,source,now),sourceId=source?.messageId||null;
  const autonomous=state.autonomousWake===true||autonomousReason(state.lastWakeReason);
  const previous=store.actions.filter(a=>a.key===key&&['sent','reserved','uncertain'].includes(a.status));
  const current=previous.filter(a=>sourceId&&a.sourceMessageId===sourceId&&now-a.at<10*MINUTE);
  const questions=questionInfo(messages),advice=adviceLike(messages);
  let reason;
  if(!judgment.adviceRequested&&advice)reason='没有明确的建议请求或正在倾听/收尾；请先回应原话，不自动展开解决方案';
  else if(questions.count+current.reduce((n,a)=>n+a.questions.count,0)>judgment.maxQuestions)reason='当前问题额度已用完或无需追问；本次未发送，请直接回应或等待新信息';
  else if(sourceId&&questions.topics.some(topic=>previous.some(a=>now-a.at<30*MINUTE&&a.questions.topics.includes(topic)&&(a.sourceMessageId===sourceId||['brief','listen','closing'].includes(judgment.need)))))reason='这个问题刚问过，不换个说法再问；先使用已有信息或等待';
  else if(sourceId&&current.length>=judgment.maxBubbles)reason='同一轮已经作出足够回应，本次停止继续补话';
  else if(judgment.maxChars&&[...messages.join('\n')].length>judgment.maxChars)reason='当前先简短回应，不把倾诉或收尾扩展成长篇';
  else if(voiceUnknown&&['listen','brief','closing'].includes(judgment.need))reason='当前不发送内容无法核对的预录语音；可使用有正文的简短语音回应';
  else if(autonomous&&judgment.contactCooldown)reason='近期明确要求减少主动联系，本次不额外打扰';
  else if(autonomous&&['closing','brief'].includes(judgment.need))reason='用户正在收尾，本次不再主动联系';
  else if(autonomous&&previous.some(a=>a.autonomous&&a.sourceMessageId===sourceId&&now-a.at<6*60*MINUTE))reason='已经主动联系而没有新来信，本次不继续打扰';
  return {judgment,questions,advice,autonomous,reason};
}
export class SituationBlocked extends Error {
  constructor(reason){super('[SITUATION_PAUSED] '+reason);this.code='SITUATION_PAUSED';this.status=403;}
}
export async function executeSituationSend({file,key,state,messages=[],voiceUnknown=false,appliedFeedbackIds=[],execute,now=Date.now}) {
  let action,blocked;
  updateJson(file,empty(),store=>{
    const at=now(),decision=judgeSend(store,key,state,messages,voiceUnknown,at);
    let judgment=store.judgments.find(j=>j.key===key&&j.source?.messageId===decision.judgment.source?.messageId&&j.need===decision.judgment.need);
    if(!judgment){judgment={id:id(),key,at,...decision.judgment};store.judgments.push(judgment);}
    action={id:id(),key,at,judgmentId:judgment.id,sourceMessageId:decision.judgment.source?.messageId||null,
      contentHash:hash(messages.join('\n')),questions:decision.questions,adviceLike:decision.advice,autonomous:decision.autonomous,
      appliedFeedbackIds,status:decision.reason?'blocked':'reserved',reason:decision.reason||null};
    store.actions.push(action);blocked=decision.reason;return store;
  });
  if(blocked)throw new SituationBlocked(blocked);
  try {
    const result=await execute();
    try{updateJson(file,empty(),s=>{const a=s.actions.find(a=>a.id===action.id);a.status='sent';a.finishedAt=now();a.messageId=result?.message_id==null?null:String(result.message_id);a.meaning='工具确认发送或动作成功，不证明已读或满意';return s;});}catch{/* Never resend a completed operation because logging failed. */}
    return result;
  } catch(error) {
    try{updateJson(file,empty(),s=>{const a=s.actions.find(a=>a.id===action.id);a.status=error?.status===403||Number(error?.retcode)>=100?'failed':'uncertain';a.finishedAt=now();return s;});}catch{}
    throw error;
  }
}
export function observeSituation(file,key,msg,ownerQQ,now=Date.now()) {
  if(!msg?.messageId||msg.isSelf)return;
  const source=latestIncoming({recentMessages:[msg]});if(!source)return;
  updateJson(file,empty(),store=>{
    if(store.judgments.some(j=>j.key===key&&j.source?.messageId===source.messageId))return store;
    const judgment={id:id(),key,at:now,...inferSituation(source,now)};store.judgments.push(judgment);
    if(!msg.isOwner||(msg.userId!=null&&String(msg.userId)!==String(ownerQQ)))return store;
    const q=source.quote;
    if(/假如|假设|开玩笑|转述|没有说|没说|并不是|^朋友说|^他说|^她说/.test(q))return store;
    const corrections=[[/别.*建议|不要.*建议|不用.*建议|你又.*建议|只想.*(?:说|吐槽)/,'over_advice',a=>a.adviceLike],
      [/别.*问|不要.*问|不用.*问|问过了|又问|已经说过/,'repeated_question',a=>a.questions.count>0],
      [/别.*主动|别打扰|不要打扰|先别找我|别.*连发/,'over_contact',a=>a.autonomous],
      [/别.*(?:套|照搬).*偏好|不是每次|别总按|不用管.*(?:以前|之前|偏好)/,'preference_mismatch',a=>a.appliedFeedbackIds?.length>0]];
    for(const [pattern,kind,match]of corrections)if(pattern.test(q)){
      const target=store.actions.filter(a=>a.key===key&&a.status==='sent'&&a.at<=source.at&&source.at-a.at<24*60*MINUTE&&match(a)).at(-1);
      store.calibrations.push({id:id(),key,at:now,source,kind,targetActionId:target?.id||null,
        result:target?'user_correction_of_matching_action':'explicit_boundary_without_matching_execution',
        limitation:'仅记录用户明确纠正；最近匹配动作不等于因果证明，不根据沉默推断不满'});
    }
    if(/^(这样就好|这样可以|这次回答刚好|你理解对了)[。！!\s]*$/.test(q)){
      const target=store.actions.filter(a=>a.key===key&&a.status==='sent'&&a.at<=source.at&&source.at-a.at<30*MINUTE).at(-1);
      if(target)store.calibrations.push({id:id(),key,at:now,source,kind:'explicit_positive_feedback',targetActionId:target.id,result:'user_explicitly_approved_this_response_only'});
    }
    return store;
  });
}
export function situationHint(file,key,state,now=Date.now()) {
  let view;try{view=situationView(file,key,state,now);}catch{return '\n【情境判断】记录不可读，保留原数据；先简短回应，不自动追加建议、追问或主动联系。\n';}
  return '\n【情境判断与行动尺度】'+JSON.stringify({sourceMessageId:view.source?.messageId,need:view.need,basis:view.basis,maxQuestions:view.maxQuestions,maxBubbles:view.maxBubbles,certainty:view.certainty})
    +'。这是暂定判断，不是读心。倾诉先接住话，任务按要求做；只有影响结果的缺失信息才问一次，不默认询问“要不要我陪你/给建议”。用户当次明确要求优先于可覆盖的旧表达偏好，不能改写长期记录或绕过权限。'
    +'\n近期明确校准：'+JSON.stringify(view.calibrations.slice(-3).map(c=>({kind:c.kind,result:c.result,sourceMessageId:c.source.messageId})))
    +'。没有新回复仅表示没收到回复，不是负面反馈；不要为了校准再追着问满意不满意。\n';
}
