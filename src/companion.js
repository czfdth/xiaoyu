// 读 companion 配置：优先加密文件，回退明文。
//
// 加密用 Windows DPAPI（CurrentUser），只有这台机器的这个用户能解开。
// 刻意做成"读不到就回退明文"：任何时刻都不至于因为她读不到 key 而整个哑掉。
//
// 用法：import { readCompanion } from './companion.js'; const cfg = readCompanion();

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMPANION_CONFIG } from './paths.js';

const cache = { at: 0, mtime: 0, value: null };

function psRun(commands) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', commands.join('; ')], {
    encoding: 'utf8',
    timeout: 60000,
  });
}

/** DPAPI 解密（ProtectedData）。失败返回 null，由调用方回退。 */
export function dpapiDecrypt(blob) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-dp-'));
  const inFile = path.join(dir, 'in.txt');
  const outFile = path.join(dir, 'out.bin');
  try {
    fs.writeFileSync(inFile, String(blob).trim(), 'ascii');
    psRun([
      'Add-Type -AssemblyName System.Security',
      `$s = [IO.File]::ReadAllText('${inFile}', [Text.Encoding]::ASCII)`,
      `$p = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s), $null, 'CurrentUser')`,
      `[IO.File]::WriteAllBytes('${outFile}', $p)`,
    ]);
    return fs.readFileSync(outFile, 'utf8');
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** DPAPI 加密。 */
export function dpapiEncrypt(plain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-dp-'));
  const inFile = path.join(dir, 'in.bin');
  const outFile = path.join(dir, 'out.txt');
  try {
    fs.writeFileSync(inFile, Buffer.from(plain, 'utf8'));
    psRun([
      'Add-Type -AssemblyName System.Security',
      `$b = [IO.File]::ReadAllBytes('${inFile}')`,
      `$p = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')`,
      `[IO.File]::WriteAllText('${outFile}', [Convert]::ToBase64String($p), [Text.Encoding]::ASCII)`,
    ]);
    return fs.readFileSync(outFile, 'utf8').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 读 companion 配置。
 * @param {{file?:string, force?:boolean}} [options]
 * @returns {object} 解析失败/文件不存在都返回 {}
 */
export function readCompanion({ file = COMPANION_CONFIG, force = false } = {}) {
  const encFile = `${file}.dpapi`;
  let mtime = 0;
  try { mtime = Math.max(fs.statSync(file).mtimeMs, fs.existsSync(encFile) ? fs.statSync(encFile).mtimeMs : 0); } catch { /* 忽略 */ }
  if (!force && cache.value && cache.mtime === mtime && cache.file === file) return cache.value;

  let text = '';
  if (fs.existsSync(encFile)) {
    const plain = dpapiDecrypt(fs.readFileSync(encFile, 'utf8'));
    if (plain) text = plain;
  }
  if (!text) {
    try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  }
  let value = {};
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')) ?? {}; } catch { value = {}; }
  Object.assign(cache, { at: Date.now(), mtime, file, value });
  return value;
}

/** 当前是"加密生效"还是"还是明文"——给体检/面板显示用。 */
export function companionKeyState({ file = COMPANION_CONFIG } = {}) {
  const encExists = fs.existsSync(`${file}.dpapi`);
  const plainExists = fs.existsSync(file);
  const cfg = readCompanion({ file });
  return {
    file,
    plaintext: plainExists,
    encrypted: encExists,
    hasApiKey: Boolean(cfg?.apiKey),
    usingEncrypted: encExists && Boolean(dpapiDecrypt(fs.existsSync(`${file}.dpapi`) ? fs.readFileSync(`${file}.dpapi`, 'utf8') : '')),
  };
}
