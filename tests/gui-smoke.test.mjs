import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('GUI实际应用可启动：静态首页、安全回放与导出，且不改写数据',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyu-gui-smoke-'));
 const beforeEnv={};
 for(const [name,value] of Object.entries({XIAOYU_HOME:root,XIAOYU_DATA:root,XIAOYU_STATE:path.join(root,'state'),XIAOYU_LOGS:path.join(root,'logs')})){
  beforeEnv[name]=process.env[name];process.env[name]=value;
 }
 fs.mkdirSync(path.join(root,'state'),{recursive:true});
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({ownerQQ:10001,allow:{private:[10001],groups:[]},snowluma:{},dsh:{}}));
 fs.writeFileSync(path.join(root,'state/console-token'),'gui-smoke-test-token-1234');
 fs.writeFileSync(path.join(root,'state/life.json'),'{}');
 const original=fs.readFileSync(path.join(root,'state/life.json'),'utf8'),config=fs.readFileSync(path.join(root,'config.json'),'utf8');
 let app;
 t.after(async()=>{await app?.close();for(const [name,value]of Object.entries(beforeEnv)){if(value===undefined)delete process.env[name];else process.env[name]=value;}fs.rmSync(root,{recursive:true,force:true});});
 const {buildApp}=await import('../gui/server/app.mjs');
 const guiDir=fileURLToPath(new URL('../gui/',import.meta.url));
 app=await buildApp({guiDir});await app.ready();
 const headers={host:'127.0.0.1','x-console-token':'gui-smoke-test-token-1234'};
 assert.equal((await app.inject({url:'/api/health',headers})).json().ok,true);
 const home=await app.inject({url:'/',headers});assert.equal(home.statusCode,200);assert.match(home.body,/<html/i);
 const scripts=[...home.body.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g)].map(m=>m[1]);assert(scripts.length);
 for(const url of scripts)assert.equal((await app.inject({url,headers})).statusCode,200,url);
 const replay=await app.inject({method:'POST',url:'/api/security/replay',headers,payload:{text:'普通聊天'}});assert.equal(replay.statusCode,200);assert.equal(replay.json().wouldBlock,false);
 const sensitive=await app.inject({method:'POST',url:'/api/security/replay',headers,payload:{text:'C:\\Users\\best\\private.txt'}});assert.equal(sensitive.json().wouldBlock,true);
 const unauthorized=await app.inject({method:'POST',url:'/api/security/replay',headers:{host:'127.0.0.1'},payload:{text:'普通聊天'}});assert.equal(unauthorized.statusCode,401);
 const invalid=await app.inject({method:'POST',url:'/api/security/replay',headers,payload:{text:''}});assert.equal(invalid.statusCode,400);
 const exported=await app.inject({url:'/api/security/export?format=csv',headers});assert.equal(exported.statusCode,200);assert.match(exported.body,/time,key,reason,has_known_token,text/);
 assert.equal(fs.readFileSync(path.join(root,'state/life.json'),'utf8'),original);assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),config);
});
