import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Called only after OneBot returned success, never on intended/failed sends.
export function recordDelivery(file, action, params, result, now = Date.now()) {
  if (!['send_private_msg','send_group_msg'].includes(action) || result?.message_id == null) return null;
  const key = action === 'send_private_msg' ? `private:${params.user_id}` : `group:${params.group_id}`;
  const segments = Array.isArray(params.message) ? params.message : [];
  const hashes = segments.filter(s => ['image','record','video'].includes(s.type) && String(s.data?.file || '').startsWith('base64://'))
    .map(s => crypto.createHash('sha256').update(Buffer.from(s.data.file.slice(9), 'base64')).digest('hex'));
  const entry = { key, messageId: String(result.message_id), isSelf: true, time: now,
    artifactHashes: hashes, text: segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').slice(0, 500) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  return entry;
}
