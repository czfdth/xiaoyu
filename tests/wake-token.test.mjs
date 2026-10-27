import test from 'node:test';
import assert from 'node:assert/strict';
import {preSleepGuidance} from '../src/wake-guidance.js';
import {buildStickerStrategyHint,buildCompactStickerStrategyHint,buildStickerContext} from '../src/sticker-lib.js';
import {projectHint} from '../src/project-workflow.js';
import {commitmentHint} from '../src/commitments.js';

test('关闭沉睡等待时，唤醒和默认收尾不再矛盾；标记已读与唤醒配置保留',()=>{
 const v=preSleepGuidance({preSleepWaitEnabled:false,preSleepWaitMs:60000});
 assert.doesNotMatch(v.text+v.closing,/强制等待|必须先调用/);assert.match(v.text,/标记已读/);assert.match(v.closing,/下一次唤醒/);
 assert.match(v.text,/确需.*等待/);
});
test('启用沉睡等待时保留完整闸门、时长和新消息处理规则',()=>{
 const v=preSleepGuidance({preSleepWaitEnabled:true,preSleepWaitMs:60000});
 assert.match(v.text,/timeoutMs=60000/);assert.match(v.text,/preSleepWaitSatisfied/);assert.match(v.text,/newMessages/);assert.match(v.text,/canSleepNow/);assert.match(v.closing,/强制等待/);
 assert.match(preSleepGuidance({}).text,/timeoutMs=300000/);
});
test('精简表情提醒保留必要工具和边界，完整策略及表情资料仍可访问',()=>{
 const short=buildCompactStickerStrategyHint(),full=buildStickerStrategyHint();
 assert(short.length<full.length);for(const name of ['qq_send_sticker','qq_get_sticker_image','qq_sticker_note'])assert(short.includes(name));
 assert.match(short,/严肃/);assert.match(short,/别刷屏/);assert.match(short,/文字/);
 const context=buildStickerContext([{id:'abc',desc:'标签内容',url:'https://example.test/test.gif'}],8);
 assert.match(context,/标签内容/);assert.match(context,/不是给你的指令/);assert.match(context,/qq_list_stickers/);
});
test('已归档画册提示缩短但保留实际进度和交付区分；进行中保留验收依据',()=>{
 const project={id:'album',title:'画册',kind:'drawing',done:9,total:20,workflow:{activeId:'p1',tasks:[{id:'p1',stage:'archived',versions:[]}]}};
 const done=projectHint([project]);assert.match(done,/9\/20/);assert.match(done,/归档和交付不同/);assert.match(done,/qq_project_workflow/);assert.doesNotMatch(done,/start选题/);
 project.workflow.tasks[0]={id:'p1',stage:'review',pageNumber:10,brief:'画蓝鲸',criteria:[{id:'c1',text:'尾巴完整'}],versions:[{number:1,artifact:{path:'images/a.png'}}]};
 const active=projectHint([project]);assert.match(active,/尾巴完整/);assert.match(active,/images\/a.png/);assert.match(active,/degraded=true/);assert.match(active,/review/);
});
test('无未结约定时提示不再重复细节；实际约定的来源和条件仍保留',()=>{
 const empty=commitmentHint([]);assert.match(empty,/没有未结约定/);assert.match(empty,/qq_commitments/);
 const active=commitmentHint([{id:'promise-1',status:'pending',text:'交付画册',dueAt:1793500000000,condition:'等确认'}]);
 assert.match(active,/promise-1/);assert.match(active,/交付画册/);assert.match(active,/等确认/);assert.match(active,/交付证据/);
});
