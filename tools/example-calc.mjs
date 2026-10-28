// 示例：一个自定义工具。
//
// 把它复制成 tools/你的工具.mjs，改掉 name / description / schema / handler 就行。
// 桥接启动时会自动扫描 tools/*.mjs 并注册到她的工具表里。
//
// 约定（必须遵守，否则加载失败）：
//   export const name        —— 工具名，建议 qq_ 开头，全局唯一
//   export const description —— 给她看的一句话（她靠这句话决定什么时候用）
//   export const schema      —— { 参数名: zod 类型 }，没有参数就写 {}
//   export async function run(args) —— 返回字符串（或 { text } / { error }）
//
// 安全边界：
//   · 工具跑在 MCP 进程里，能读写本机文件 —— 只装你信得过的代码
//   · 想要"发消息给 QQ"，用 args 里拿不到的桥接内部函数是拿不到的，
//     需要发消息请直接在 handler 里调 OneBot HTTP（和桥接用同一个地址）
//   · 出错会被捕获，不会让整个 MCP 挂掉；但会记进日志

import { z } from 'zod';

export const name = 'qq_calc';

export const description =
  '算一个数学表达式（+ - * / % ** 和括号）。大模型心算容易错，涉及到钱和数量的计算先用它。';

export const schema = {
  expr: z.string().describe('要计算的表达式，比如 (12.8 / 3) * 5'),
};

export async function run({ expr }) {
  const text = String(expr ?? '').trim();
  if (!text) return { error: '表达式是空的' };
  // 只允许数字、运算符、括号和小数点 —— 不 eval 任意代码
  if (!/^[\d\s+\-*/%.()**]+$/.test(text)) {
    return { error: '只支持数字和 + - * / % ** 括号' };
  }
  try {
    // 用 Function 而不是 eval，作用域更干净；上面已经限制了字符集
    const value = Function('"use strict"; return (' + text + ')')();
    if (typeof value !== 'number' || !Number.isFinite(value)) return { error: '算不出有效数字' };
    const rounded = Math.round(value * 1e6) / 1e6;
    return text + ' = ' + rounded;
  } catch (error) {
    return { error: '算不了：' + (error?.message ?? error) };
  }
}
