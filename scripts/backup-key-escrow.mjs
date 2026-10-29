// 备份密钥托管：把 state/backup-key 导出成一份可离线保存的恢复包，
// 并用最新出站备份做一次解密验证（证明这把 key 真的能恢复）。
//
// 输出目录：config.backup.keyEscrowDir，默认 %LOCALAPPDATA%\xiaoyu\recovery（不参与 OneDrive 同步）
// 注意：backup-key.txt 里是明文密钥。存进密码管理器/离线 U 盘后，请删除本文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT as ROOT, STATE_DIR } from '../src/paths.js';

const LOG = path.join(STATE_DIR, 'backup-key-escrow.log');
const KEY_FILE = path.join(STATE_DIR, 'backup-key');
const MAGIC = Buffer.from('XYBK1');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const opt = cfg.backup || {};

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* ignore */ }
}

function offsiteDir() {
  if (opt.offsiteDir) return String(opt.offsiteDir).replace(/^~/, process.env.USERPROFILE || '');
  const oneDrive = process.env.OneDrive || path.join(process.env.USERPROFILE || '', 'OneDrive');
  if (oneDrive && fs.existsSync(oneDrive)) return path.join(oneDrive, 'xiaoyu-backups');
  return path.join(ROOT, 'backups');
}

function escrowDir() {
  if (opt.keyEscrowDir) return String(opt.keyEscrowDir).replace(/^~/, process.env.USERPROFILE || '');
  // 默认放 LOCALAPPDATA：Documents 常被 OneDrive 同步，
  // 明文密钥跟着云同步等于把钥匙贴在保险箱上（安全审查 P1-06）。
  return path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || ROOT, 'xiaoyu', 'recovery');
}

function decrypt(key, src) {
  const raw = fs.readFileSync(src);
  if (!raw.subarray(0, 5).equals(MAGIC)) throw new Error('不是 XYBK 加密备份');
  const iv = raw.subarray(5, 17);
  const tag = raw.subarray(17, 33);
  const body = raw.subarray(33);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

const key = (() => {
  try { return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64'); }
  catch { throw new Error('没有 state/backup-key，先跑一次 backup-offsite.mjs'); }
})();
if (key.length !== 32) throw new Error('backup-key 长度不对（应为 32 字节）');
const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

const dir = offsiteDir();
const candidates = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => /^xiaoyu-.*\.enc$/i.test(f))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
  : [];
if (!candidates.length) throw new Error(`出站目录没有 .enc 备份：${dir}`);

const latest = candidates[0].name;
const decrypted = decrypt(key, path.join(dir, latest));
if (!decrypted.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('解密结果不是 zip');

const out = escrowDir();
fs.mkdirSync(out, { recursive: true });
const issued = new Date().toLocaleString('zh-CN');
const keyText = [
  '小鱼 · 备份密钥（离线恢复用）',
  '',
  `生成时间: ${issued}`,
  `密钥指纹: SHA256:${fingerprint}`,
  `机器: ${process.env.COMPUTERNAME || ''} / ${process.env.USERNAME || ''}`,
  `验证备份: ${latest}`,
  '',
  '密钥（Base64，32 字节）:',
  key.toString('base64'),
  '',
  '用法: 在新机器安装小鱼后，把上面这行密钥保存为 state/backup-key，',
  '再用 scripts/decrypt-backup.mjs 解密 .enc，然后用 bin/restore.ps1 恢复。',
  '',
  '⚠️ 这是明文密钥。存进密码管理器或离线 U 盘后，请删除本文件。',
  '',
].join('\n');
// 明文密钥只落在默认目录（LOCALAPPDATA，不参与云同步）；别处必须显式同意。
if (path.resolve(out) !== path.resolve(path.join(String(process.env.LOCALAPPDATA || ''), 'xiaoyu', 'recovery')) && !process.argv.includes('--allow-plaintext-key')) {
  console.error('写到非默认目录需要显式同意：加 --allow-plaintext-key');
  process.exit(2);
}
fs.writeFileSync(path.join(out, 'backup-key.txt'), keyText, 'utf8');

const recovery = [
  '# 小鱼备份恢复包',
  '',
  `- 密钥指纹：\`SHA256:${fingerprint}\``,
  `- 验证时间：${issued}`,
  `- 验证备份：\`${latest}\`（解密成功，zip 头正确）`,
  '',
  '## 恢复步骤',
  '',
  '1. 安装小鱼（解压发行包 → `安装.bat`）。',
  '2. 从密码管理器/离线介质取出 `backup-key.txt` 里的 Base64 密钥，写入：',
  '   `%LOCALAPPDATA%\\xiaoyu\\state\\backup-key`（只放这一行）。',
  '3. 从 OneDrive 的 `xiaoyu-backups` 取最新的 `.zip.enc`，解密：',
  '   ```powershell',
  '   node scripts\\decrypt-backup.mjs <备份.zip.enc> <输出.zip>',
  '   ```',
  '4. 恢复：',
  '   ```powershell',
  '   powershell -File bin\\restore.ps1 -From <输出.zip> -Force',
  '   ```',
  '',
  '## 注意',
  '',
  '- 没有密钥，`.enc` 文件无法恢复；密钥和备份不要放在同一块盘。',
  '- 恢复会覆盖当前 `state/`，脚本会先自动备份。',
  '',
].join('\n');
fs.writeFileSync(path.join(out, 'RECOVERY.md'), recovery, 'utf8');

log(`托管完成：${out}（指纹 ${fingerprint}，验证 ${latest}）`);
console.log(JSON.stringify({ ok: true, dir: out, fingerprint: `SHA256:${fingerprint}`, verified: latest }, null, 2));
