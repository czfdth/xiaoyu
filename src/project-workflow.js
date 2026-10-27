import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, updateJson } from './state-store.js';
import { verifyArtifact } from './commitments.js';
import { looksLikeImageBuffer } from './safe-fetch.js';

const OPEN = new Set(['generate','review','revise','ready_to_archive','blocked']);
const RETRY_MS = 30 * 60000;

export function taskCriteria(task, feedback = []) {
  const criteria = [...(task.criteria || [])];
  if(task.stage==='archived')return criteria;
  for(const f of feedback) {
    if(!['art_style','character','requirement'].includes(f.dimension)||f.status!=='active'||(f.scope==='task'&&f.taskId!==task.id))continue;
    if(!criteria.some(c=>c.id==='feedback:'+f.id))criteria.push({id:'feedback:'+f.id,text:f.source.quote,feedbackId:f.id,source:'owner_feedback'});
  }
  return criteria;
}

export function projectView(file, key, feedback = []) {
  const store = readJson(file, { items: [] });
  return (store.items || []).map(p => {
    const wf = p.workflow;
    return { id: p.id, title: p.title, kind: p.kind, done: p.done, total: p.total,
      workflow: wf?.conversationKey === key ? {...wf,tasks:wf.tasks.map(t=>({...t,criteria:taskCriteria(t,feedback)}))} : null };
  });
}

export function nextProjectWork(projects, key, now = Date.now()) {
  for (const p of projects) {
    const wf = p.workflow;
    if (!wf || wf.conversationKey !== key) continue;
    const task = wf.tasks.find(t => t.id === wf.activeId);
    if (!task || !OPEN.has(task.stage)) continue;
    if (task.stage === 'blocked' && (task.needsHelp || !task.retryAt || task.retryAt > now)) continue;
    return { id: task.id, projectId: p.id, stage: task.stage, nextAction: task.stage === 'blocked' ? 'resume' : task.stage, brief: task.brief };
  }
  return null;
}

function sourceMessage(context, id) {
  return context.messages?.find(m => m.messageId != null && String(m.messageId) === String(id) && m.isOwner && !m.isSelf);
}

function imageEvidence(root, file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('必须提供实际图片文件路径');
  const evidence = verifyArtifact(root, file);
  if (!/\.(png|jpe?g|webp|gif)$/i.test(evidence.path) || !looksLikeImageBuffer(fs.readFileSync(path.resolve(root, evidence.path)))) {
    throw new Error('画册页面必须是可识别的图片文件');
  }
  return evidence;
}

export function changeProject(file, key, input, context) {
  const now = context.now || Date.now();
  let result;
  updateJson(file, { items: [] }, store => {
    const p = (store.items || []).find(p => p.id === (input.projectId || store.active));
    if (!p || p.kind !== 'drawing') throw new Error('没有找到绘画项目');
    if (p.workflow && p.workflow.conversationKey !== key) throw new Error('项目流程属于其他会话');
    const action = input.action;
    let wf = p.workflow;
    let task = wf?.tasks.find(t => t.id === (input.taskId || wf.activeId));
    if (action === 'start') {
      const active = wf?.tasks.find(t => t.id === wf.activeId);
      if (active && OPEN.has(active.stage)) { result = { projectId: p.id, task: active }; return store; }
      if ((Number(p.done) || 0) >= (Number(p.total) || 0)) throw new Error('画册已经完成');
      const request = sourceMessage(context, input.sourceMessageId);
      if(input.sourceMessageId&&!request)throw new Error('找不到用户的任务原话，不能冒充用户要求');
      if (wf?.lastArchivedAt && now - wf.lastArchivedAt < RETRY_MS && (!request || (request.time || request.at || 0) < wf.lastArchivedAt)) throw new Error('上一页刚归档，自主活动先休息一会儿；用户明确要求可继续');
      const brief = String(input.brief || '').trim().slice(0, 600);
      if (!brief) throw new Error('先选好这一页的主题、构图和要练习的内容');
      wf ||= { version: 1, conversationKey: key, tasks: [] };
      task = { id: 'page-' + crypto.randomUUID(), pageNumber: (Number(p.done) || 0) + 1,
        brief, stage: 'generate', createdAt: now, versions: [], failures: 0, history: [] };
      task.origin=request?'owner_request':'self_selected';
      task.request=request?{messageId:String(request.messageId),text:String(request.plain||request.text||'').slice(0,1200),at:request.time||request.at}:null;
      const requested=Array.isArray(input.criteria)&&input.criteria.length?input.criteria:[brief];
      if(requested.length>8||requested.some(c=>typeof c!=='string'||!c.trim()))throw new Error('验收标准需为1到8条具体文字');
      task.criteria=requested.map((c,i)=>({id:'c'+(i+1),text:c.trim().slice(0,400),source:'agent_plan'}));
      task.criteria=taskCriteria(task,context.feedback||[]);
      wf.tasks.push(task); wf.activeId = task.id; p.workflow = wf;
    } else {
      if (!task) throw new Error('还没有页面任务，先用 start 选题');
      if (action === 'archive' && task.stage === 'archived') { result = { projectId: p.id, task }; return store; }
      if (action === 'deliver' && task.delivery) { result = { projectId: p.id, task }; return store; }
      if (!OPEN.has(task.stage) && action !== 'deliver') throw new Error('页面已经归档，不再改写原页面；需要修改请另开新页');
      const current = task.versions.at(-1);
      if (action === 'attach') {
        if (!['generate','revise'].includes(task.stage)) throw new Error('当前步骤不接受新草稿');
        if (task.versions.length >= 3 && !task.extraVersionAllowed) throw new Error('这一页已尝试三版，请记录受阻并请用户帮助，不再反复生成');
        const evidence = imageEvidence(context.root, input.evidencePath);
        if (task.versions.some(v => v.artifact.sha256 === evidence.sha256) || (p.artifacts || []).some(a => a.sha256 === evidence.sha256)) throw new Error('同一件作品不能当成新版本或新页面');
        if (fs.statSync(path.resolve(context.root, evidence.path)).mtimeMs + 2000 < task.createdAt) throw new Error('这是任务开始前的旧图片，不能直接冒充这一页的新草稿');
        task.versions.push({ number: task.versions.length + 1, artifact: evidence, attachedAt: now });
        task.stage = 'review'; task.retryAt = null;
      } else if (action === 'review') {
        if (!['review','ready_to_archive'].includes(task.stage) || !current) throw new Error('先生成并关联实际草稿，再检查');
        const note = String(input.note || '').trim().slice(0, 600);
        if (!note || !['accept','revise'].includes(input.verdict)) throw new Error('检查要给出 accept/revise 和具体理由');
        let feedback = null;
        if (input.feedbackMessageId) {
          const msg = sourceMessage(context, input.feedbackMessageId);
          if (!msg || (msg.time || msg.at || 0) < task.createdAt) throw new Error('反馈必须来自当前会话、任务开始后的用户消息');
          feedback = { messageId: String(msg.messageId), text: String(msg.plain || msg.text || '').slice(0, 500) };
          if(input.verdict==='revise'&&!(task.criteria||[]).some(c=>c.id==='message:'+msg.messageId)) {
            task.criteria||=[];task.criteria.push({id:'message:'+msg.messageId,text:feedback.text,source:'owner_feedback'});
          }
        }
        task.criteria=taskCriteria(task,context.feedback||[]);
        const checks=Array.isArray(input.checks)?input.checks:[];
        if(new Set(checks.map(c=>c.id)).size!==checks.length)throw new Error('验收项不能同时提供多份相互冲突的检查结果');
        if(input.verdict==='accept'&&task.criteria.some(c=>!checks.some(check=>check.id===c.id&&check.passed===true&&typeof check.note==='string'&&check.note.trim().length>=4))) {
          throw new Error('每项验收标准都需要具体检查结果，不能只说不错；待检查:'+task.criteria.map(c=>c.id).join(','));
        }
        current.review = { at: now, verdict: input.verdict, note, checks, kind: feedback ? 'user_feedback_with_agent_assessment' : 'agent_self_review', feedback };
        task.stage = input.verdict === 'accept' ? 'ready_to_archive' : 'revise';
        if (input.verdict === 'revise' && task.versions.length >= 3) {
          task.stage = 'blocked'; task.blockedFrom = 'revise'; task.needsHelp = true; task.retryAt = null; task.blockedAt = now;
          task.lastError = '三版仍未通过检查，请用户决定下一步'; task.errorSource = 'agent_self_review';
        }
      } else if (action === 'block') {
        const note = String(input.note || '').trim().slice(0, 600);
        if (!note) throw new Error('受阻要保留实际原因和下一步');
        let error = note;
        if (input.failureEventId) {
          const event = context.observations?.find(e => e.id === input.failureEventId && e.conversationKey === key && e.ok === false && e.at >= task.createdAt);
          if (!event) throw new Error('找不到这个任务之后、同会话的实际失败记录');
          error = `${event.tool}: ${event.detail}`;
          task.failureEventIds ||= [];
          if (task.failureEventIds.includes(event.id)) { result = { projectId: p.id, task }; return store; }
          task.failureEventIds.push(event.id);
        }
        if (task.stage !== 'blocked') task.blockedFrom = task.stage;
        task.failures += 1; task.lastError = error; task.nextStep = note; task.stage = 'blocked';
        task.errorSource = input.failureEventId ? 'tool_observation' : 'agent_report';
        task.needsHelp = task.failures >= 3 || task.versions.length >= 3;
        task.retryAt = task.needsHelp ? null : now + RETRY_MS;
        task.blockedAt = now;
      } else if (action === 'resume') {
        if (task.stage !== 'blocked') throw new Error('任务未受阻，不需要恢复');
        const message = sourceMessage(context, input.sourceMessageId);
        const operator = context.operatorConfirmation;
        const confirmed = (operator && typeof operator.reason === 'string' && operator.reason.trim()) || (message && (message.time || message.at || 0) >= task.blockedAt);
        if (operator?.reason) { task.operatorConfirmations ||= []; task.operatorConfirmations.push({ at: now, reason: operator.reason.slice(0, 600), source: 'authenticated_operator' }); }
        if (task.needsHelp && !confirmed) throw new Error('已停止自动重试，需要用户在当前会话明确决定后继续');
        if (task.retryAt > now && !confirmed) throw new Error('尚未到重试时间，不重复尝试');
        task.stage = task.blockedFrom || 'generate'; task.retryAt = null; task.needsHelp = false;
        if (confirmed) { task.failures = 0; if (task.versions.length >= 3) task.stage = 'generate'; task.extraVersionAllowed = true; }
      } else if (action === 'archive') {
        if (task.stage !== 'ready_to_archive' || current?.review?.verdict !== 'accept') throw new Error('这一页还没有通过检查');
        const required=taskCriteria(task,context.feedback||[]);
        if(required.some(c=>!current.review.checks?.some(check=>check.id===c.id&&check.passed===true)))throw new Error('新要求或用户反馈尚未逐项验收，请先重新检查');
        const evidence = imageEvidence(context.root, current.artifact.path);
        if (evidence.sha256 !== current.artifact.sha256) throw new Error('图片已变化，需要重新关联并检查，不能归档旧检查结果');
        if (task.pageNumber !== (Number(p.done) || 0) + 1) throw new Error('项目进度已由其他操作改变，先核对再归档');
        p.artifacts ||= [];
        if (p.artifacts.some(a => a.sha256 === evidence.sha256)) throw new Error('作品已经归档');
        p.artifacts.push({ ...evidence, taskId: task.id, pageNumber: task.pageNumber, review: current.review, registeredAt: now });
        p.done = task.pageNumber; p.note = `第${task.pageNumber}页：${task.brief.slice(0, 80)}`;
        task.stage = 'archived'; task.archivedAt = now; wf.lastArchivedAt = now;
      } else if (action === 'deliver') {
        if (task.stage !== 'archived') throw new Error('先完成检查和归档，再记录正式交付');
        const receipt = context.messages?.find(m => m.isSelf && String(m.messageId) === String(input.deliveredMessageId)
          && (m.time || m.at || 0) >= task.createdAt && m.artifactHashes?.includes(current.artifact.sha256));
        if (!receipt) throw new Error('找不到与归档作品匹配的当前会话交付回执');
        task.delivery = { messageId: String(receipt.messageId), at: receipt.time || receipt.at, sha256: current.artifact.sha256 };
      } else throw new Error('未知页面操作');
    }
    if (input.action === 'attach' && task.extraVersionAllowed) delete task.extraVersionAllowed;
    task.updatedAt = now; p.updatedAt = now;
    task.history.push({ at: now, action: input.action, stage: task.stage, note: String(input.note || '').slice(0, 600) });
    result = { projectId: p.id, done: p.done, total: p.total, task };
    return store;
  });
  return result;
}

export function projectHint(projects) {
  const p = projects.find(p => p.kind === 'drawing' && (p.done < p.total || p.workflow));
  if (!p) return '';
  const wf = p.workflow, task = wf?.tasks.find(t => t.id === wf.activeId);
  if (!task || task.stage === 'archived') return `\n【画册执行流程】${p.title} ${p.done}/${p.total}。${task ? '上一页已归档；归档和交付不同。' : '历史进度保留，没有认证历史作品。'}用 qq_project_workflow 查看和接续，实际作品与检查为准，不自动汇报。\n`;
  const base = '\n【画册执行流程】用 qq_project_workflow 查看/接续页面：start选题 → qq_draw不传key只生成不发 → attach关联实际文件 → review具体检查 → 必要时再生成修改版 → archive归档。不能用口头“画好了”跳步骤。一次独立活动推进一页的一小步，不为汇报而发消息。自检只代表模型判断，不能冒充用户认可。qq_draw若返回degraded=true，说明已换成本地插画；按实际效果检查，不能声称主模型生成成功，也不要因主服务失败再反复调用它。\n';
  const v = task.versions.at(-1);
  const criteriaLine='验收清单（review accept必须提供每项id、passed=true与具体note）：'+JSON.stringify(task.criteria||[])+'\n';
  return base + criteriaLine + `项目:${p.id} 任务:${task.id} 第${task.pageNumber}页 [${task.stage}] 主题:${task.brief}\n`
    + (v ? `当前草稿:${v.artifact.path}，第${v.number}版。${v.review ? '检查/修改要求:' + v.review.note + (v.review.feedback ? ' 用户原话:' + v.review.feedback.text : '') : ''}\n` : '')
    + (task.lastError ? `受阻记录[${task.errorSource || '来源待核实'}]:${task.lastError}；下一步:${task.nextStep || ''}。${task.needsHelp ? '暂停自动尝试，等待用户决定。' : task.retryAt ? '重试时间:' + new Date(task.retryAt).toISOString() : ''}\n` : '');
}
