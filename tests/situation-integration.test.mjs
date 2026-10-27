import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeJson,readJson} from '../src/state-store.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('真实bridge/MCP与假QQ协议：新来信、拦截、回执和偏好例外',{timeout:90000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-situation-it-')),key='private:10001',token='situation-test-agent-token',admin='situation-test-console-token';
 let bridge,client,output='',count=0,seq=600;const sockets=new Set(),sent=[];
 const gateway=http.createServer((req,res)=>{let text='';req.on('data',d=>text+=d);req.on('end',()=>{
  const action=req.url.slice(1),params=JSON.parse(text||'{}');let data=[];
  if(action.startsWith('send_')){sent.push({action,params});data={message_id:++count};}
  else if(action==='get_login_info')data={user_id:10002,nickname:'test'};
  else if(action==='get_status')data={online:true,good:true};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
 });});
 gateway.on('upgrade',(req,socket)=>{
  const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.on('data',()=>{});
 });
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const base='http://127.0.0.1:'+port,headers={'x-console-token':admin,'content-type':'application/json'},env={...process.env,XIAOYU_HOME:root,XIAOYU_DATA:root,XIAOYU_STATE:path.join(root,'state'),XIAOYU_LOGS:path.join(root,'logs'),DSH_HOME:path.join(root,'fake-dsh')};
 writeJson(path.join(root,'config.json'),{ownerQQ:10001,consolePort:port,consoleToken:admin,allow:{private:[10001],groups:[]},deny:{private:[],groups:[]},sessionCwd:root,dsh:{baseUrl:'http://127.0.0.1:1'},snowluma:{httpUrl:'http://127.0.0.1:'+gateway.address().port,wsUrl:'ws://127.0.0.1:'+gateway.address().port,accessToken:'fake'},socialV2:{proactive:{enabled:false},wake:{preSleepWaitMs:0},voice:{groupVoice:false},send:{burstIntervalMinMs:0,burstIntervalMaxMs:0}}});
 writeJson(path.join(root,'state/mode.json'),{mode:'reserved2'});
 writeJson(path.join(root,'state/social-v2.json'),{conversations:{[key]:{agentToken:token,bootstrapSent:true,recentMessages:[],wakeConfig:{mode:'diving',infinite:true,triggers:{atMention:true}}}}});
 const api=async(route,body,agent=token)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{...headers,...(agent?{'x-agent-token':agent}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 t.after(async()=>{try{await client?.close();}catch{}if(bridge&&bridge.exitCode===null){bridge.kill();await sleep(500);}for(const socket of sockets)socket.destroy();await new Promise(r=>gateway.close(r));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 bridge=spawn(process.execPath,['src/bridge.js'],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});bridge.stdout.on('data',d=>output+=d);bridge.stderr.on('data',d=>output+=d);
 for(let i=0;i<150;i++){try{if((await api('/api/status',null,null)).status===200&&sockets.size)break;}catch{}await sleep(100);}
 assert(sockets.size,output.slice(-2000));assert.equal((await api('/api/mode',{mode:'reserved2'},null)).status,200);
 client=new Client({name:'situation-it',version:'1'},{capabilities:{}});await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp-snowluma-safe.js'],cwd:process.cwd(),env,stderr:'ignore'}));
 const call=async(messages)=>client.callTool({name:'qq_send_message',arguments:{key,token,messages}});
 const incoming=async text=>{
  const id=++seq,body=Buffer.from(JSON.stringify({time:Math.floor(Date.now()/1000),self_id:10002,post_type:'message',message_type:'private',sub_type:'friend',message_id:id,user_id:10001,raw_message:text,message:[{type:'text',data:{text}}],sender:{user_id:10001,nickname:'owner'}}));
  const head=body.length<126?Buffer.from([0x81,body.length]):Buffer.from([0x81,126,body.length>>8,body.length&255]);for(const s of sockets)s.write(Buffer.concat([head,body]));
  for(let i=0;i<60;i++){const state=await api('/api/socialV2/state?key='+key);if(state.data.situation?.source?.messageId===String(id))return state.data;await sleep(50);}throw new Error('来信未进入真实bridge：'+output.slice(-1200));
 };
 await incoming('我今天好累，只想吐槽');
 const blocked=await call('建议你先运动，再早睡');assert.equal(blocked.isError,true,JSON.stringify(blocked));assert.equal(sent.length,0);
 assert.equal((await call('要不要聊聊？')).isError,true);assert.equal(sent.length,0);
 const okay=await call('今天辛苦了，我听着。');assert.notEqual(okay.isError,true,JSON.stringify(okay));assert.equal(sent.length,1);
 assert.equal((await call('再问一句你怎么样？')).isError,true);assert.equal(sent.length,1);
 await incoming('现在帮我分析怎么解决');assert.notEqual((await call('建议你先列出当前最紧急的事')).isError,true);assert.equal(sent.length,2);
 await incoming('别总给建议');const view=(await api('/api/socialV2/state?key='+key)).data.situation;assert.equal(view.calibrations.at(-1).kind,'over_advice');assert.ok(view.calibrations.at(-1).targetActionId);
 await incoming('今天事情真多');assert.equal((await call('你应该先安排计划')).isError,true);assert.equal(sent.length,2);
 // Preference comes from actual incoming, then the next current request overrides only presentation.
 const short=await incoming('以后说话简短一点');
 const feedback=await api('/api/socialV2/continuity',{key,action:'feedback',sourceMessageId:short.situation.source.messageId,scope:'conversation',dimension:'detail'});assert.equal(feedback.status,200,JSON.stringify(feedback));
 const before=fs.readFileSync(path.join(root,'state/continuity.json'),'utf8');
 await incoming('这次详细解释怎么解决');const effective=await api('/api/socialV2/continuity?key='+key);assert.equal(effective.data.policy.maxTextChars,null);assert.ok(effective.data.situationalOverride);assert.equal(fs.readFileSync(path.join(root,'state/continuity.json'),'utf8'),before);
 assert.notEqual((await call('建议你先检查文件路径。'+'这里是具体解释。'.repeat(20))).isError,true);assert.equal(sent.length,3);
 await incoming('你好');assert.equal((await api('/api/socialV2/continuity?key='+key)).data.policy.maxTextChars,120);
 assert.equal((await api('/api/socialV2/state?key='+key,null,'wrong-token')).status,403);
 const stored=readJson(path.join(root,'state/situation.json'));assert.equal(stored.actions.filter(a=>a.status==='sent').length,3);assert.equal(stored.actions.filter(a=>a.status==='sent').every(a=>a.messageId),true);
});
