#!/usr/bin/env node
// 文档理解的第一步：把文件里的文字抽出来。
//
// 为什么先做抽取：她看不懂 PDF/Word，不是模型的问题，是**文字根本没进到上下文**。
// 抽出来之后，任何能读文本的模型都能"看懂"。
//
// 支持：.txt .md .json .csv .log（直读）
//       .docx .pptx .xlsx（解 zip，取 word/document.xml 等里的 <w:t> / <a:t>）
//       .pdf（尽力而为：从内容流里抓可读片段，扫描版抽不出来）
//
// 用法：
//   node scripts/read-doc.mjs <文件>            # 打印前 4000 字
//   node scripts/read-doc.mjs <文件> --json     # 输出 {file, kind, chars, text}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) {
  console.error('用法: node scripts/read-doc.mjs <文件> [--json]');
  process.exit(1);
}

const abs = path.resolve(file);
if (!fs.existsSync(abs)) {
  console.error('文件不存在:', abs);
  process.exit(1);
}

const ext = path.extname(abs).toLowerCase();

/** 从 OOXML（docx/pptx/xlsx）里取文字：解压后按 XML 标签抓。 */
function readOoxml(target) {
  // 用 PowerShell 的 Expand-Archive 解到临时目录（Windows 自带，不引依赖）
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'xy-doc-'));
  try {
    const zipCopy = path.join(tmp, 'doc.zip');
    fs.copyFileSync(target, zipCopy);
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipCopy.replace(/'/g, "''")}' -DestinationPath '${path.join(tmp, 'x').replace(/'/g, "''")}' -Force`,
    ], { timeout: 60000 });

    const wanted = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) { walk(full); continue; }
        if (/\.(xml)$/i.test(name.name)) wanted.push(full);
      }
    };
    walk(path.join(tmp, 'x'));

    // 按 OOXML 的文字标签抓：docx 是 <w:t>，pptx 是 <a:t>，xlsx 是 <t>
    const parts = [];
    for (const f of wanted) {
      const base = path.basename(f);
      if (!/^(document|slide\d+|sharedStrings)\.xml$/i.test(base)) continue;
      const xml = fs.readFileSync(f, 'utf8');
      const matches = xml.match(/<(?:w|a|t):?t[^>]*>([^<]*)<\/(?:w|a|t):?t>/g) ?? xml.match(/<t[^>]*>([^<]*)<\/t>/g) ?? [];
      for (const m of matches) {
        const text = m.replace(/<[^>]+>/g, '').trim();
        if (text) parts.push(text);
      }
    }
    return parts.join('\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** PDF：尽力而为。压缩流里的文字抓不出来（那是常见情况），这里只捞未压缩的可读片段。 */
function readPdf(target) {
  const buf = fs.readFileSync(target);
  const raw = buf.toString('latin1');
  const chunks = [];
  // PDF 文本操作符：(...) Tj / [(...) ...] TJ
  const re = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ)/g;
  let m;
  while ((m = re.exec(raw))) {
    const text = m[1]
      .replace(/\\([()\\])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    if (text.trim()) chunks.push(text);
  }
  return chunks.join('');
}

let kind = 'text';
let text = '';
try {
  if (['.docx', '.pptx', '.xlsx'].includes(ext)) { kind = ext.slice(1); text = readOoxml(abs); }
  else if (ext === '.pdf') { kind = 'pdf'; text = readPdf(abs); }
  else { kind = 'text'; text = fs.readFileSync(abs, 'utf8'); }
} catch (error) {
  console.error('抽取失败:', error?.message ?? error);
  process.exit(1);
}

text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const out = { file: abs, kind, chars: text.length, text };
if (asJson) {
  console.log(JSON.stringify(out));
} else {
  console.log(`# ${path.basename(abs)}（${kind}，${text.length} 字）\n`);
  console.log(text.slice(0, 4000) || '（没抽到文字：可能是扫描版 PDF 或纯图片文档）');
}
