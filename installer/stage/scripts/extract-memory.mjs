// 按会话分批提炼，成功批次落盘后才推进游标。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, STATE_DIR } from '../src/paths.js';
import { readCompanion } from '../src/companion.js';
import { extractDay } from '../src/memory-extraction.js';
import { readJson } from '../src/state-store.js';
import { shanghaiDay } from '../src/autonomy.js';
const args = process.argv.slice(2);
const day = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || shanghaiDay();
const log = message => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, 'memory-extract.log'), `${new Date().toISOString()} ${message}\n`);
  console.log(message);
};
try {
  const cfg = readJson(CONFIG_FILE, {});
  if (!cfg.ownerQQ) throw new Error('尚未设置用户身份，不能推断记忆归属');
  const companion = readCompanion();
  if (!companion.apiKey) throw new Error('没有记忆提炼模型的 API key');
  const base = String(companion.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  // 本地 Ollama：走原生 /api/chat 才能关掉 thinking。qwen3 这类模型的思维链会白烧几分钟，
  // 还经常把 JSON 挤到 max_tokens 之外；OpenAI 兼容端点没有这个开关。
  const isOllama = String(companion.provider ?? '').toLowerCase() === 'ollama' || /:11434\b/.test(base);
  const ollamaBase = base.replace(/\/v1\/?$/, '');
  const result = await extractDay({ stateDir: STATE_DIR, ownerQQ: cfg.ownerQQ, day, dry: args.includes('--dry'), log,
    complete: async prompt => {
      if (isOllama) {
        const response = await fetch(`${ollamaBase}/api/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: companion.model || 'qwen3:30b',
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            think: companion.think === true,
            options: { temperature: 0.2, num_predict: 8000 }
          }),
          signal: AbortSignal.timeout(Number(companion.timeoutMs) || 1800000)
        });
        if (!response.ok) throw new Error(`模型 HTTP ${response.status}`);
        const data = await response.json();
        if (data.done_reason === 'length') throw new Error('模型输出截断，未保存当前批次，可重试');
        const content = data.message?.content;
        if (!content) throw new Error('模型未返回内容');
        return content;
      }
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${companion.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: companion.model || 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 8000 }),
        signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) throw new Error(`模型 HTTP ${response.status}`);
      const data = await response.json();
      if (data.choices?.[0]?.finish_reason === 'length') throw new Error('模型输出截断，未保存当前批次，可重试');
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型未返回内容');
      return content;
    } });
  log(`${day} 完成：流水 ${result.rows}，新处理批次 ${result.processed}，拒绝 ${result.rejected}`);
} catch (error) { log(`FAILED: ${error.message}`); process.exitCode = 1; }
