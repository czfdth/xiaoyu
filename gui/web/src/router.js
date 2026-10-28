import { createRouter, createWebHistory } from 'vue-router';
import Overview from './pages/Overview.vue';
import Her from './pages/Her.vue';
import Memory from './pages/Memory.vue';
import Knowledge from './pages/Knowledge.vue';
import Persona from './pages/Persona.vue';
import Tools from './pages/Tools.vue';
import Spend from './pages/Spend.vue';
import Life from './pages/Life.vue';
import Works from './pages/Works.vue';
import Config from './pages/Config.vue';
import Logs from './pages/Logs.vue';
import Security from './pages/Security.vue';
import Setup from './pages/Setup.vue';

export const routes = [
  { path: '/', name: 'overview', component: Overview, meta: { title: '概览', sub: '服务、引擎、她此刻的样子' } },
  { path: '/her', name: 'her', component: Her, meta: { title: '她', sub: '内部状态、身体、今天的对话' } },
  { path: '/life', name: 'life', component: Life, meta: { title: '一生', sub: '出生、天数、阶段、她经历过的事' } },
  { path: '/works', name: 'works', component: Works, meta: { title: '画', sub: '她画过的东西，按月归拢' } },
  { path: '/kg', name: 'kg', component: Knowledge, meta: { title: '关系', sub: '她记得的关于你的事，和它们有多确定' } },
  { path: '/memory', name: 'memory', component: Memory, meta: { title: '记忆', sub: '日记、回忆录、梦、幻想、知识' } },
  { path: '/tools', name: 'tools', component: Tools, meta: { title: '工具', sub: '她现在能用的全部工具' } },
  { path: '/spend', name: 'spend', component: Spend, meta: { title: '花费', sub: 'token 花在哪，以及几个刹车' } },
  { path: '/persona', name: 'persona', component: Persona, meta: { title: '人格卡', sub: '每条消息都会注入的那张卡' } },
  { path: '/config', name: 'config', component: Config, meta: { title: '配置', sub: '白名单、模型、网关、引擎路径' } },
  { path: '/logs', name: 'logs', component: Logs, meta: { title: '日志', sub: '她今天都干了什么' } },
  { path: '/security', name: 'security', component: Security, meta: { title: '安全', sub: '被本地策略拦下的回复' } },
  { path: '/setup', name: 'setup', component: Setup, meta: { title: '首次设置', sub: '四步把她接上 QQ' } },
];

export default createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
