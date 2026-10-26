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

const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r,ms));

test('真 bridge + 真 MCP + 假 QQ：归属、履约、进度、失败发送和重启', { timeout: 180000 }, async t => {
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
  const headers={'x-console-token':admin,'content-type':'application/json'};
  const env={...process.env,DSH_HOME:path.join(root,'fake-dsh'),DSH_PROFILE:'test',XIAOYU_HOME:root,XIAOYU_DATA:root,XIAOYU_STATE:path.join(root,'state'),XIAOYU_LOGS:path.join(root,'logs')};
  writeJson(path.join(root,'config.json'),{ownerQQ:10001,consoleToken:admin,consolePort:port,allow:{private:[10001],groups:[10]},deny:{private:[],groups:[]},sessionCwd:root,
    dsh:{baseUrl:'http://127.0.0.1:1'},snowluma:{httpUrl:`http://127.0.0.1:${gateway.address().port}`,wsUrl:'ws://127.0.0.1:1',accessToken:'fake'},socialV2:{wake:{preSleepWaitMs:0},proactive:{enabled:false},send:{burstIntervalMinMs:100,burstIntervalMaxMs:100}}});
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
  assert.doesNotMatch(prompt.data.role.hint, /今天有点麻烦/);
  const call=async(name,args)=>{
    const r=await client.callTool({name,arguments:args});
    const text=r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    let data;try{data=JSON.parse(text);}catch{data=text;}
    return {error:r.isError===true,data};
  };
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
  assert.equal((await call('qq_project_workflow',{key,token,action:'review',verdict:'accept',note:'主体与构图符合主题，文件可以读取'})).error,false);
  assert.equal((await call('qq_project_workflow',{key,token,action:'archive'})).error,false);
  const pageSent=await call('qq_send_image',{key,image:'page10.png'});assert.equal(pageSent.error,false);
  const delivered=await call('qq_project_workflow',{key,token,action:'deliver',deliveredMessageId:String(pageSent.data.messageId)});
  assert.equal(delivered.error,false,JSON.stringify(delivered));
  assert.equal(readJson(path.join(root,'state/projects.json')).items[0].done,10);
  assert.equal((await call('qq_project_update',{advance:1,evidencePath:'images/page10.png'})).error,true);
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
  assert.equal(sent.length,3); // One image + one successful text, all against the fake gateway.
});
