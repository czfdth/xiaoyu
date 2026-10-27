import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeJson, readJson } from '../src/state-store.js';
const code=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('实际 MCP 语音链路：假引擎503后换备用，新进程下一句跳过失败引擎，未知发送不改发文字', {timeout:60000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-tts-adaptive-'));
 let primary=0,sends=0,drop=false;const sent=[];
 const gateway=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{
  const params=JSON.parse(data||'{}');
  if(req.url==='/tts'){primary++;res.writeHead(503);res.end('test engine unavailable');return;}
  if(req.url==='/send_private_msg'||req.url==='/send_group_msg'){
   sends++;sent.push(params);if(drop){res.destroy();return;}
   res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:sends}}));return;
  }
  res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:1}}));
 });});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>gateway.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${gateway.address().port}`,modules=path.join(root,'mock-modules');fs.mkdirSync(modules);
 // Test-only edge_tts stand-in writes a tiny WAV using stdlib. No cloud voice or real QQ is contacted.
 fs.writeFileSync(path.join(modules,'edge_tts.py'),"import argparse,wave\np=argparse.ArgumentParser();p.add_argument('--voice');p.add_argument('--file');p.add_argument('--write-media');a=p.parse_args()\nwith wave.open(a.write_media,'wb') as w:\n w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\\0\\0'*1600)\n");
 const ref=path.join(root,'reference.wav');fs.writeFileSync(ref,'test-reference');
 writeJson(path.join(root,'config.json'),{ownerQQ:10001,allow:{private:[10001],groups:[]},snowluma:{httpUrl:base,accessToken:'test'},socialV2:{voice:{ttsProvider:'gpt-sovits',gptSovits:{url:base,refAudioPath:ref}}}});
 const env={...process.env,XIAOYU_HOME:root,XIAOYU_STATE:path.join(root,'state'),QQ_BRIDGE_PYTHON:process.env.XIAOYU_TEST_PYTHON||'python',PYTHONPATH:modules};
 const say=async text=>{
  const client=new Client({name:'tts-adaptive-test',version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp-snowluma-safe.js'],cwd:code,env,stderr:'ignore'}));
  try {return await client.callTool({name:'qq_say',arguments:{key:'private:10001',text}});}finally{await client.close();}
 };
 assert.notEqual((await say('第一句测试')).isError,true);assert.equal(primary,1);assert.equal(sends,1);
 assert.notEqual((await say('第二句测试')).isError,true);assert.equal(primary,1);assert.equal(sends,2);
 const learned=readJson(path.join(root,'state/experience-learning.json'));
 assert(learned.applications.some(a=>a.chosen[0]==='fallback'&&a.outcome==='fallback_succeeded'));
 drop=true;const uncertain=await say('断开连接的测试句');assert.equal(uncertain.isError,true);assert.match(uncertain.content[0].text,/DELIVERY_UNCERTAIN/);assert.equal(sends,3);
 const retry=await say('断开连接的测试句');assert.equal(retry.isError,true);assert.equal(sends,3);
 assert(sent.every(p=>p.message.some(s=>s.type==='record')));
});
