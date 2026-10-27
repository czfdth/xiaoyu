import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeJson, readJson } from '../src/state-store.js';
import { reflectToolObservation } from '../src/experience-learning.js';

const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r,ms));

test('真 bridge + 真 MCP + 假 QQ：归属、履约、进度、失败发送和重启', { timeout: 180000, skip: process.env.XIAOYU_SKIP_BRIDGE_IT === '1' ? 'GitHub Windows runner: bridge integration runs locally' : false }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyu-life-integration-'));
  let bridge, client, output='', sendCount=100, failText=false;
  const sent=[];
  const gateway=http.createServer((req,res)=>{
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
      const params=JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const action=req.url.slice(1);
      if (/^send_/.test(action)) {
        const body=JSON.stringify(params);
        if (failText && body.includes('FAIL-ONLY')) { res.end(JSON.stringify({status:'failed',retcode:100,wording:'模拟失败'})); return; }
        sent.push({action,params});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:++sendCount}}));return;
      }
      res.end(JSON.stringify({status:'ok',retcode:0,data:action==='get_login_info'?{user_id:10002,nickname:'fake'}:action==='get_status'?{good:true,online:true}:[]}));
    });
  });
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const base=`http://127.0.0.1:${port}`,key='private:10001',token='integration-agent-token-12345',other='integration-group-token-12345';
  const admin='integration-console-token-12345';
  // Close each client connection so Windows releases the listener before the restart assertion.
  const headers={'x-console-token':admin,'content-type':'application/json',connection:'close'};
  const env={...process.env,DSH_HOME:path.join(root,'fake-dsh'),DSH_PROFILE:'test',XIAOYU_HOME:root,XIAOYU_DATA:root,XIAOYU_STATE:path.join(root,'state'),XIAOYU_LOGS:path.join(root,'logs')};
  writeJson(path.join(root,'config.json'),{ownerQQ:10001,consoleToken:admin,consolePort:port,allow:{private:[10001],groups:[10]},deny:{private:[],groups:[]},sessionCwd:root,
    dsh:{baseUrl:'http://127.0.0.1:1'},snowluma:{httpUrl:`http://127.0.0.1:${gateway.address().port}`,wsUrl:'ws://127.0.0.1:1',accessToken:'fake'},socialV2:{draw:{provider:'local_illustration'},wake:{preSleepWaitMs:0},proactive:{enabled:false},send:{burstIntervalMinMs:100,burstIntervalMaxMs:100}}});
  writeJson(path.join(root,'state/mode.json'),{mode:'reserved2'});
  writeJson(path.join(root,'state/social-v2.json'),{conversations:{
    [key]:{agentToken:token,bootstrapSent:true,lastIncomingAt:Date.now()-600000,wakeConfig:{mode:'diving',infinite:true,triggers:{atMention:true}},recentMessages:[{messageId:'11',isSelf:true,text:'明天给你画鱼',time:Date.now()-1000}]},
    'group:10':{agentToken:other,bootstrapSent:true,wakeConfig:{mode:'diving',infinite:true,triggers:{atMention:true}},recentMessages:[]}
  }});
  writeJson(path.join(root,'state/current-role.json'),{role:'小鱼',mode:'active'});
  fs.mkdirSync(path.join(root,'roles'),{recursive:true});fs.writeFileSync(path.join(root,'roles/小鱼.md'),'你是小鱼，称用户爸爸。');
  writeJson(path.join(root,'state/memory/long-term.json'),{items:[{id:'legacy',type:'promise',text:'旧约定'},{id:'private',text:'私聊秘密',weight:3,conversationKey:key,subjectId:'10001'},{id:'group',text:'群友喜欢绿',weight:3,conversationKey:'group:10',subjectId:'2'}]});
  writeJson(path.join(root,'state/projects.json'),{active:'album',items:[{id:'album',title:'画册',kind:'drawing',done:8,total:20}]});
  fs.mkdirSync(path.join(root,'images'),{recursive:true});
  fs.writeFileSync(path.join(root,'images/fish.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=','base64'));
  for (const [conversationKey,id] of [[key,'private-learning'],['group:10','group-learning']]) {
    reflectToolObservation(path.join(root,'state/experience-learning.json'),{id,at:Date.now(),realityKind:'tool_observation',sourceType:'bridge_tool_result',conversationKey,tool:'qq_send_image',ok:false});
  }
  const api=async(route,body,agentToken)=>{
    const r=await fetch(base+route,{method:body?'POST':'GET',headers:{...headers,...(agentToken?{'x-agent-token':agentToken}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json()};
  };
  const start=async()=>{
    bridge=spawn(process.execPath,['src/bridge.js'],{cwd:code,env,stdio:['ignore','pipe','pipe']});
    bridge.stdout.on('data',d=>output+=d);bridge.stderr.on('data',d=>output+=d);
    for(let i=0;i<100;i++) {
      try { if((await api('/api/status')).status===200) { await api('/api/mode',{mode:'reserved2'}); return; } } catch {}
      if(bridge.exitCode!==null)throw new Error(output.slice(-3000));
      await sleep(100);
    }
    throw new Error('bridge 启动超时：'+output.slice(-3000));
  };
  t.after(async()=>{
    if(client)await client.close();
    if(bridge && bridge.exitCode===null){const exit=once(bridge,'exit');bridge.kill();await exit;}
    await new Promise(r=>gateway.close(r));
    fs.rmSync(root,{recursive:true,force:true});
  });
  await start();
  const state=await api('/api/socialV2/state?key='+key,null,token);
  assert(state.data.lastIncomingAt>0, JSON.stringify(state) + '\n' + output.slice(-1800));
  const prompt=await api('/api/socialV2/prompt?key='+key,null,token);
  assert.equal(prompt.status,200);assert.match(prompt.data.role.hint,/私聊秘密/);assert.doesNotMatch(prompt.data.role.hint,/群友喜欢绿/);
  const groupPrompt=await api('/api/socialV2/prompt?key=group:10',null,other);
  assert.match(groupPrompt.data.role.hint,/群友喜欢绿/);assert.doesNotMatch(groupPrompt.data.role.hint,/私聊秘密|旧约定/);
  assert.equal((await api('/api/socialV2/commitments?key='+key,null,other)).status,403);
  assert.equal((await api('/api/socialV2/wake',{key,reason:'proactiveCheck'})).status,409);

  client=new Client({name:'life-integration',version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp-snowluma-safe.js'],cwd:code,env,stderr:'ignore'}));
  const tools=(await client.listTools()).tools;
  assert(tools.some(t=>t.name==='qq_commitments'));
  assert(tools.some(t=>t.name==='qq_learning'));
  assert.match(prompt.data.role.hint,/有执行证据的经验/);
  assert.doesNotMatch(prompt.data.role.hint, /今天有点麻烦/);
  const call=async(name,args)=>{
    const r=await client.callTool({name,arguments:args});
    const text=r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    let data;try{data=JSON.parse(text);}catch{data=text;}
    return {error:r.isError===true,data};
  };
  const learned=await call('qq_learning',{key,token});assert.equal(learned.error,false);
  assert.equal(learned.data.reflections.length,1);assert.equal(learned.data.reflections[0].conversationKey,key);
  const rule=learned.data.reflections[0].id;
  assert.equal((await api('/api/socialV2/learning?key='+key,null,other)).status,403);
  const denied=await api('/api/socialV2/learning',{key,reflectionId:rule,action:'disable',reason:'模型自行修改'},token);assert.equal(denied.status,403);
  const disabled=await api('/api/socialV2/learning',{key,reflectionId:rule,action:'disable',reason:'操作台测试停用'});assert.equal(disabled.data.reflections[0].effective,false);
  assert.equal((await api('/api/socialV2/learning?key=group:10',null,other)).data.reflections[0].effective,true);
  const enabled=await api('/api/socialV2/learning',{key,reflectionId:rule,action:'enable',reason:'操作台测试恢复'});assert.equal(enabled.data.reflections[0].effective,true);
  const dream=await call('qq_dream',{dream:'梦见胖鱼从画里游出来，游到了海边'});
  assert.equal(dream.error,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/dreams.jsonl'),'utf8').trim()).realityKind,'imagined');
  const create=await call('qq_commitments',{key,token,text:'给你画一张鱼',sourceMessageId:'11',dueAt:'2026-10-27T12:00:00+08:00'});
  assert.equal(create.error,false,JSON.stringify(create));const id=create.data.item.id;
  const noEvidence=await call('qq_project_update',{advance:1,note:'画好了'});
  assert.equal(noEvidence.error,true);assert.equal(readJson(path.join(root,'state/projects.json')).items[0].done,8);
  const image=await call('qq_send_image',{key,image:'fish.png'});assert.equal(image.error,false,JSON.stringify(image));
  const update=await call('qq_project_update',{advance:1,note:'真实作品',evidencePath:'images/fish.png'});assert.equal(update.error,false,JSON.stringify(update));
  assert.equal(readJson(path.join(root,'state/projects.json')).items[0].done,9);
  assert.equal((await call('qq_project_update',{advance:1,evidencePath:'images/fish.png'})).error,true);
  const complete=await call('qq_commitments',{key,token,id,status:'completed',evidencePath:'images/fish.png',deliveredMessageId:String(image.data.messageId)});
  assert.equal(complete.error,false,JSON.stringify(complete));assert.equal(complete.data.item.status,'completed');

  failText=true;
  const partial=await api('/api/socialV2/send-message',{key,messages:['SUCCESS-ONLY','FAIL-ONLY']},token);
  assert.equal(partial.data.ok,false);
  const journal=fs.readdirSync(path.join(root,'state/journal')).flatMap(name=>fs.readFileSync(path.join(root,'state/journal',name),'utf8').trim().split('\n').map(l=>JSON.parse(l)));
  assert.equal(journal.filter(e=>e.text==='SUCCESS-ONLY').length,1);
  assert.equal(journal.filter(e=>e.text==='FAIL-ONLY').length,0);
  assert(journal.find(e=>e.text==='SUCCESS-ONLY').messageId);
  assert.equal((await api('/api/socialV2/project-workflow?key=group:10',null,other)).status,403);
  const page=await call('qq_project_workflow',{key,token,action:'start',brief:'第十页，鲸鱼与月亮'});
  assert.equal(page.error,false,JSON.stringify(page));assert.equal(page.data.task.pageNumber,10);
  assert.equal((await call('qq_project_update',{advance:1,evidencePath:'images/fish.png'})).error,true);
  fs.writeFileSync(path.join(root,'images/page10.png'),Buffer.concat([fs.readFileSync(path.join(root,'images/fish.png')),Buffer.from([42])]));
  const attached=await client.callTool({name:'qq_project_workflow',arguments:{key,token,action:'attach',evidencePath:'images/page10.png'}});
  assert.notEqual(attached.isError,true);
  assert(attached.content.some(c=>c.type==='image' && c.mimeType==='image/png'));
  assert.equal((await call('qq_project_workflow',{key,token,action:'archive'})).error,true);
  assert.equal((await call('qq_project_workflow',{key,token,action:'review',verdict:'accept',note:'主体与构图符合主题，文件可以读取',checks:[{id:'c1',passed:true,note:'图中主体与选题一致且文件完整'}]})).error,false);
  assert.equal((await call('qq_project_workflow',{key,token,action:'archive'})).error,false);
  const pageSent=await call('qq_send_image',{key,image:'page10.png'});assert.equal(pageSent.error,false);
  const delivered=await call('qq_project_workflow',{key,token,action:'deliver',deliveredMessageId:String(pageSent.data.messageId)});
  assert.equal(delivered.error,false,JSON.stringify(delivered));
  assert.equal(readJson(path.join(root,'state/projects.json')).items[0].done,10);
  assert.equal((await call('qq_project_update',{advance:1,evidencePath:'images/page10.png'})).error,true);
  // Previous page was just archived: use a real synthetic incoming owner message, not a forged operator field.
  const projectFile=path.join(root,'state/projects.json');
  const projectState=readJson(projectFile);projectState.items[0].workflow.lastArchivedAt=0;writeJson(projectFile,projectState);
  await api('/api/socialV2/project-workflow',{key,action:'start',brief:'操作台授权测试'});
  for(let i=0;i<3;i++) await api('/api/socialV2/project-workflow',{key,action:'block',note:'模拟连接失败'});
  const forged=await api('/api/socialV2/project-workflow',{key,action:'resume',operatorReason:'模型假冒授权'},token);
  assert.equal(forged.data.ok,false);
  const authorized=await api('/api/socialV2/project-workflow',{key,action:'resume',operatorReason:'测试操作台明确授权'});
  assert.equal(authorized.data.ok,true,JSON.stringify(authorized));
  assert.equal(authorized.data.task.operatorConfirmations[0].source,'authenticated_operator');
  // Retry the actual partially failed batch: its successful bubble must not be sent or journaled twice.
  const sentBeforeRetry=sent.length;
  const replay=await api('/api/socialV2/send-message',{key,messages:['SUCCESS-ONLY','FAIL-ONLY']},token);
  assert.equal(replay.data.ok,false);assert.equal(sent.length,sentBeforeRetry);
  const repeat=await api('/api/socialV2/send-message',{key,messages:['SAME-BUBBLE','SAME-BUBBLE']},token);
  assert.equal(repeat.data.ok,true);assert.equal(sent.length,sentBeforeRetry+2);
  const repeatAgain=await api('/api/socialV2/send-message',{key,messages:['SAME-BUBBLE','SAME-BUBBLE']},token);
  assert.equal(repeatAgain.data.ok,true);assert.equal(sent.length,sentBeforeRetry+2);
  const pausedProject=await api('/api/socialV2/project-workflow',{key,action:'archive'},token);
  assert.equal(pausedProject.data.ok,false);
  const beforePause=JSON.stringify(readJson(projectFile));
  const pausedAgain=await api('/api/socialV2/project-workflow',{key,action:'archive'},token);
  assert.match(pausedAgain.data.error,/ADAPTIVE_PAUSED/);assert.equal(JSON.stringify(readJson(projectFile)),beforePause);
  const pending=await call('qq_commitments',{key,token,text:'另一个约定',sourceMessageId:'11'});assert.equal(pending.error,false);
  const oldPid=bridge.pid, exited=once(bridge,'exit');
  await api('/api/restart',{});await exited;await start();assert.notEqual(bridge.pid,oldPid);
  const after=await api('/api/socialV2/commitments?key='+key,null,token);
  assert.equal(after.data.items.find(e=>e.id===id).status,'completed');
  assert.equal(after.data.items.find(e=>e.id===pending.data.item.id).status,'pending');
  assert.equal(readJson(path.join(root,'state/memory/long-term.json')).items.length,3);
  const pages=await call('qq_project_workflow',{key,token});
  assert.equal(pages.data.projects[0].workflow.tasks[0].stage,'archived');
  assert(pages.data.projects[0].workflow.tasks[0].delivery);
  // All owner statements here are synthetic fixtures confined to the fake-QQ test root.
  const fixtureJournal=path.join(root,'state/journal',new Date().toISOString().slice(0,10)+'.jsonl');
  const ownerLine=(messageId,text)=>fs.appendFileSync(fixtureJournal,JSON.stringify({key,role:'owner',senderId:'10001',messageId,text,t:Date.now()})+'\n');
  ownerLine('style-owner','以后不要模板插画');
  const style=await call('qq_continuity',{key,token,action:'feedback',sourceMessageId:'style-owner',dimension:'art_style',scope:'conversation'});assert.equal(style.error,false,JSON.stringify(style));
  assert.equal(style.data.policy.avoidLocalTemplates,true);
  const refusedTemplate=await call('qq_draw',{contextKey:key,token,prompt:'鲸鱼与月亮',fallbackTemplate:'whale'});
  assert.equal(refusedTemplate.error,true);assert.match(refusedTemplate.data,/不要模板/);
  const refusedSketch=await call('qq_sketch',{contextKey:key,token,template:'whale',caption:'测试'});assert.equal(refusedSketch.error,true);assert.match(refusedSketch.data,/不要模板/);
  assert.equal((await call('qq_continuity',{key,token:other})).error,true);
  ownerLine('bubble-owner','以后别连发，一条就好');
  const contact=await call('qq_continuity',{key,token,action:'feedback',sourceMessageId:'bubble-owner',dimension:'contact',scope:'conversation'});assert.equal(contact.error,false);
  const beforeMerge=sent.length;
  const merged=await api('/api/socialV2/send-message',{key,messages:['第一段测试','第二段测试']},token);
  assert.equal(merged.data.ok,true,JSON.stringify(merged));assert.equal(sent.length,beforeMerge+1);
  assert(sent.at(-1).params.message.some(s=>s.type==='text'&&s.data.text.includes('第一段测试\n第二段测试')));
  const extra=await api('/api/socialV2/send-message',{key,messages:'再追加一段测试'},token);assert.equal(extra.data.ok,false);assert.equal(sent.length,beforeMerge+1);
  ownerLine('retract-bubble','撤回少连发这条要求');
  assert.equal((await call('qq_continuity',{key,token,action:'retract_feedback',id:contact.data.result.id,sourceMessageId:'retract-bubble'})).error,false);
  const plan=await call('qq_continuity',{key,token,action:'practice_start',title:'构图练习',motive:'想学习把主体放清楚',skill:'drawing',steps:[{text:'画鲸鱼',criterion:'主体完整'}]});assert.equal(plan.error,false,JSON.stringify(plan));
  const practiceId=plan.data.result.id;
  assert.equal((await call('qq_continuity',{key,token,action:'self_update',field:'interest',value:'想练习构图',reason:'选择了一个小计划',evidenceIds:[practiceId]})).error,false);
  fs.writeFileSync(path.join(root,'images/practice-fresh.png'),Buffer.concat([fs.readFileSync(path.join(root,'images/fish.png')),Buffer.from([99])]));
  const preview=await client.callTool({name:'qq_continuity',arguments:{key,token,action:'practice_attach',id:practiceId,stepId:'step-1',evidencePath:'images/practice-fresh.png'}});
  assert.notEqual(preview.isError,true);assert(preview.content.some(c=>c.type==='image'));
  const checked=await call('qq_continuity',{key,token,action:'practice_review',id:practiceId,stepId:'step-1',passed:true,note:'测试协议：文件是实际可读取图片，检查为代理自评'});assert.equal(checked.error,false,JSON.stringify(checked));
  assert.equal(checked.data.result.status,'completed');assert.equal(checked.data.result.reviews[0].kind,'agent_self_assessment');
  ownerLine('quiet-owner','先别找我，30分钟让我静静');
  const quiet=await call('qq_continuity',{key,token,action:'feedback',sourceMessageId:'quiet-owner',dimension:'contact',scope:'session'});assert.equal(quiet.error,false);
  const noContact=await api('/api/socialV2/send-message',{key,messages:'主动打扰测试'},token);assert.equal(noContact.data.ok,false);assert.match(noContact.data.error,/暂不主动/);
  ownerLine('retract-quiet','撤回安静要求，恢复聊天');
  assert.equal((await call('qq_continuity',{key,token,action:'retract_feedback',id:quiet.data.result.id,sourceMessageId:'retract-quiet'})).error,false);
  ownerLine('repair-owner','你理解错了，以后别叫我爸爸');
  const corrected=await call('qq_continuity',{key,token,action:'feedback',sourceMessageId:'repair-owner',dimension:'address',scope:'conversation'});assert.equal(corrected.error,false);
  const repair=corrected.data.repairs.at(-1);assert.equal(repair.status,'open');
  assert.equal((await api('/api/socialV2/send-message',{key,messages:'爸爸，你好'},token)).data.ok,false);
  assert.equal((await api('/api/socialV2/send-message',{key,messages:'你好，我按新的称呼来'},token)).data.ok,true);
  ownerLine('repair-confirm','这样就好，你理解对了');
  const repaired=await call('qq_continuity',{key,token,action:'confirm_repair',id:repair.id,sourceMessageId:'repair-confirm'});assert.equal(repaired.error,false,JSON.stringify(repaired));assert.equal(repaired.data.result.status,'confirmed');
  const roleWithContinuity=await api('/api/socialV2/prompt?key='+key,null,token);assert.match(roleWithContinuity.data.role.hint,/构图练习/);
  const groupedContinuity=await call('qq_continuity',{key:'group:10',token:other});assert.equal(groupedContinuity.error,false);assert.equal(groupedContinuity.data.feedback.length,0);
  assert.equal(readJson(path.join(root,'state/memory/long-term.json')).items.length,3);
  assert.equal(sent.length,7); // Five original messages + one merged bubble + one corrected-address reply; all fake QQ.

});
