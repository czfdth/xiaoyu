// 解密一份出站备份：node scripts/decrypt-backup.mjs <in.zip.enc> <out.zip>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from '../src/paths.js';

const MAGIC = Buffer.from('XYBK1');
const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法: node scripts/decrypt-backup.mjs <备份.zip.enc> <输出.zip>');
  process.exit(2);
}
const keyFile = path.join(STATE_DIR, 'backup-key');
if (!fs.existsSync(keyFile)) { console.error(`缺少密钥：${keyFile}`); process.exit(1); }
const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
const raw = fs.readFileSync(src);
if (!raw.subarray(0, 5).equals(MAGIC)) { console.error('不是 XYBK 加密备份'); process.exit(1); }
const iv = raw.subarray(5, 17);
const tag = raw.subarray(17, 33);
const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
d.setAuthTag(tag);
const out = Buffer.concat([d.update(raw.subarray(33)), d.final()]);
if (!out.subarray(0, 2).equals(Buffer.from('PK'))) { console.error('解密结果不是 zip'); process.exit(1); }
fs.writeFileSync(dst, out);
const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
console.log(JSON.stringify({ ok: true, src, dst, bytes: out.length, keyFingerprint: `SHA256:${fingerprint}` }, null, 2));
