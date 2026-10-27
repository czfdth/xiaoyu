// 契约测试：把"前端以为的返回"和"后端真的返回"对上。
//
// 这里不启 HTTP 服务，而是直接调各接口背后的纯函数（skinView / usageBudgetView / vitalsView / kgView / opsView），
// 再用同一份 CONTRACT 校验形状——改字段忘了同步时，测试会直接指出是哪个键。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT, CONTRACT_ROUTES, validateBody, shapeErrors } from '../gui/shared/contract.mjs';

test('契约：登记的每条路由都有响应 schema，且键不为空', () => {
  for (const route of CONTRACT_ROUTES) {
    const entry = CONTRACT[route];
    assert.ok(entry.response, `${route} 缺 response schema`);
    assert.ok(Object.keys(entry.response).length > 0, `${route} response 是空的`);
  }
});

test('validateBody：缺必填、类型错、越界都能点出字段名', () => {
  // /api/remote 的字段都非必填，只传 port 应该通过（必填的语义留给需要它的接口）
  assert.equal(validateBody('/api/remote', { port: 8765 }).ok, true);

  const badType = validateBody('/api/skin', { enabled: 'yes' });
  assert.equal(badType.ok, false);
  assert.match(badType.errors[0], /enabled/);

  const outOfRange = validateBody('/api/skin', { veil: 1.5 });
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.errors[0], /veil/);

  const good = validateBody('/api/skin', { enabled: true, veil: 0.2, boot: true, sound: false });
  assert.deepEqual(good, { ok: true, errors: [] });

  // 未知字段忽略（向前兼容）
  assert.equal(validateBody('/api/skin', { enabled: true, newThing: 1 }).ok, true);
  assert.equal(validateBody('/api/unknown', {}).ok, true);
});

test('shapeErrors：缺键和类型不对都指出来', () => {
  const errs = shapeErrors({ enabled: true, veil: 'x' }, CONTRACT['/api/skin'].response);
  assert.match(errs.join(' '), /veil/, '类型不对要报');
  assert.doesNotMatch(errs.join(' '), /boot/, '非必填字段缺了不报');
  assert.deepEqual(shapeErrors({ enabled: true, veil: 0.1, boot: true, sound: true }, CONTRACT['/api/skin'].response), []);
  assert.deepEqual(shapeErrors(null, CONTRACT['/api/skin'].response), ['返回不是对象']);
});

// ── 真接口（纯函数层）对形状 ───────────────────────────────────────────
test('skinView 的返回符合 /api/skin 契约', async () => {
  const { skinView } = await import('../gui/server/data.mjs');
  const view = skinView();
  assert.deepEqual(shapeErrors(view, CONTRACT['/api/skin'].response), []);
});

test('usageBudgetView 的返回符合 /api/usage/budget 契约', async () => {
  const { usageBudgetView } = await import('../gui/server/data.mjs');
  assert.deepEqual(shapeErrors(usageBudgetView(), CONTRACT['/api/usage/budget'].response), []);
});

test('remoteView 的返回符合 /api/remote 契约', async () => {
  const { remoteView } = await import('../gui/server/data.mjs');
  assert.deepEqual(shapeErrors(remoteView(), CONTRACT['/api/remote'].response), []);
});

test('vitalsView / kgView / opsView 的返回符合各自契约', async () => {
  const vitals = await import('../gui/server/vitals.mjs');
  const kg = await import('../gui/server/kg.mjs');
  const ops = await import('../gui/server/ops.mjs');
  assert.deepEqual(shapeErrors(vitals.vitalsView({}), CONTRACT['/api/vitals'].response), []);
  assert.deepEqual(shapeErrors(kg.kgView(), CONTRACT['/api/kg'].response), []);
  assert.deepEqual(shapeErrors(ops.opsView(), CONTRACT['/api/ops'].response), []);
});
