// 接口契约：一份声明式 schema，服务端用它校验请求，测试用它验返回。
//
// 现状是"接口靠约定"：后端返回什么、前端以为是什么，全靠人记。字段一改，
// 页面就静默显示 undefined。这个文件就是那份约定，尽量便宜：不引依赖、不生成代码。
//
// 用法：
//   validateBody('/api/skin', body)        → {ok, errors:['veil 必须是 0~0.8 的数字']}
//   shapeErrors(data, CONTRACT['/api/skin'].response) → ['enabled 应该是 boolean，实际 undefined']

const t = {
  bool: (v) => typeof v === 'boolean',
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  str: (v) => typeof v === 'string',
  arr: (v) => Array.isArray(v),
  obj: (v) => v != null && typeof v === 'object' && !Array.isArray(v),
  any: () => true,
};

const nameOf = { bool: '布尔', num: '数字', str: '字符串', arr: '数组', obj: '对象', any: '任意值' };

/** 字段声明：'bool' | {type, min, max, required, enum} */
function checkField(key, value, spec) {
  const conf = typeof spec === 'string' ? { type: spec } : spec;
  const want = conf.type ?? 'any';
  const errors = [];
  if (value === undefined) {
    if (conf.required) errors.push(`${key} 必填（${nameOf[want]}）`);
    return errors;
  }
  if (!t[want](value)) {
    errors.push(`${key} 应该是${nameOf[want]}，实际 ${value === null ? 'null' : typeof value}`);
    return errors;
  }
  if (want === 'num') {
    if (Number.isFinite(conf.min) && value < conf.min) errors.push(`${key} 不能小于 ${conf.min}`);
    if (Number.isFinite(conf.max) && value > conf.max) errors.push(`${key} 不能大于 ${conf.max}`);
  }
  if (Array.isArray(conf.enum) && conf.enum.length && !conf.enum.includes(value)) {
    errors.push(`${key} 只能是 ${conf.enum.join(' / ')}`);
  }
  return errors;
}

/**
 * 校验请求体：只校验声明过的字段，多余的字段忽略（向前兼容）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateBody(route, body) {
  const entry = CONTRACT[route];
  if (!entry?.body) return { ok: true, errors: [] };
  if (!t.obj(body)) return { ok: false, errors: ['请求体必须是 JSON 对象'] };
  const errors = [];
  for (const [key, spec] of Object.entries(entry.body)) {
    errors.push(...checkField(key, body[key], spec));
  }
  return { ok: errors.length === 0, errors };
}

/** 校验响应形状：缺字段/类型不对都报出来（测试和前端守卫共用）。 */
export function shapeErrors(data, schema) {
  if (!schema) return [];
  // 允许把整个返回值声明成一种类型（例如 /api/reports 直接返回数组）
  if (typeof schema === 'string') return checkField('返回值', data, schema);
  if (!t.obj(data)) return ['返回不是对象'];
  const errors = [];
  for (const [key, spec] of Object.entries(schema)) {
    errors.push(...checkField(key, data[key], spec));
  }
  return errors;
}

/**
 * 接口约定。只登记"前端真的在用"的那几个，不追求覆盖全部 82 条。
 * 加新接口时在这里补一行，测试会自动跟着验。
 */
export const CONTRACT = {
  '/api/skin': {
    body: {
      enabled: 'bool',
      boot: 'bool',
      sound: 'bool',
      veil: { type: 'num', min: 0, max: 0.8 },
    },
    response: { enabled: 'bool', veil: 'num', boot: 'bool', sound: 'bool' },
  },
  '/api/usage/budget': {
    body: {
      dailyTokens: { type: 'num', min: 0 },
      proactivePerDay: { type: 'num', min: 0 },
    },
    response: { day: 'str', tokens: 'num', proactive: 'num', limits: 'obj', blocked: 'bool', reason: 'str' },
  },
  '/api/remote': {
    body: {
      enabled: 'bool',
      allowWrite: 'bool',
      port: { type: 'num', min: 1024, max: 65535 },
      password: { type: 'str' },
    },
    response: { enabled: 'bool', port: 'num', allowWrite: 'bool', hasPassword: 'bool', lan: 'arr', minPassword: 'num' },
  },
  '/api/vitals': {
    response: { generatedAt: 'num', gauges: 'arr', now: 'obj', series: 'arr', activity: 'arr', stats: 'obj' },
  },
  '/api/kg': {
    response: { generatedAt: 'num', entities: 'arr', totals: 'obj', network: 'obj', facts: 'arr' },
  },
  '/api/overview': {
    response: {
      root: 'str', ports: 'obj', capabilities: 'obj', gateway: 'obj', dsh: 'obj',
      alerts: 'arr', her: 'obj', counts: 'obj', journal: 'obj', now: 'num',
    },
  },
  '/api/her': { response: { inner: 'obj', body: 'obj', mood: 'obj', role: 'str' } },
  '/api/tokens': { response: { days: 'arr', sessions: 'arr', budget: 'obj' } },
  '/api/tools': { response: { groups: 'arr', total: 'num', enabledTotal: 'num', disabledTotal: 'num' } },
  '/api/journal/days': { response: { days: 'arr' } },
  '/api/config': { response: { config: 'obj', meta: 'obj', warnings: 'arr' } },
  '/api/reports': { response: 'arr' },
  '/api/ops': {
    response: { disk: 'obj', keys: 'obj', drill: 'any', index: 'any' },
  },
};

export const CONTRACT_ROUTES = Object.keys(CONTRACT);
